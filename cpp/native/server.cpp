// pwa-code native server.
//
// A fast_io async HTTP/1.1 server that:
//   * serves the built PWA (docs/), including precompressed .br/.gz assets;
//   * exposes a tiny workspace file API for the "remote storage" volume;
//   * provides an interactive PTY terminal over RFC 6455 WebSocket.
//
// Every failure travels on the herbception channel (`throws` /
// `catch throws (::std::error)`).  There are no errno returns, no boolean
// status results and no legacy C++ exceptions in this file.  The PTY is
// pumped with the async scheduler too: no std::thread and no blocking read
// loop.
//
// Local Network Access (LNA) is enforced per connection with fast_io's
// lna_allows(), exactly like the fast_io async http-server example.  By default
// only loopback/local peers may connect.
//
// Build:
//   clang++ --config=$HOME/cfgs/x86_64-linux-gnu-libcxx.cfg \
//       -fherbceptions -lherbceptions -O3 -flto=thin -s -pthread \
//       -fno-exceptions -fno-rtti -fno-unwind-tables \
//       -fno-asynchronous-unwind-tables -fno-ident \
//       cpp/native/server.cpp -o pwacode-server
#include <fast_io.h>
#include <fast_io_device.h>
#include <fast_io_crypto.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/string_view.h>
#include <fast_io_dsal/vector.h>

#include <cstddef>
#include <cstdint>
#include <cstring>

#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

namespace fi = ::fast_io;
namespace fop = ::fast_io::operations;

namespace
{

constexpr fi::u8string_view sv(fi::u8string const &s) noexcept
{
	return fi::u8string_view{s.data(), s.size()};
}

constexpr fi::u8string_view sv(fi::u8string_view s) noexcept
{
	return s;
}

struct server_cfg
{
	server_cfg() throws = default;
	server_cfg(server_cfg const &) throws = default;
	server_cfg(server_cfg &&) throws = default;
	server_cfg &operator=(server_cfg const &) throws = default;
	server_cfg &operator=(server_cfg &&) throws = default;
	~server_cfg() noexcept = default;
	fi::u8string root_path;
	fi::u8string workspace;
	::std::uint_least16_t port{8099};
	fi::ip_address_space lna_max{fi::ip_address_space::local_address};
};

struct request
{
	request() noexcept = default;
	fi::u8string_view method{};
	fi::u8string_view target{};
	fi::u8string_view version{};
	fi::u8string_view connection{};
	fi::u8string_view upgrade{};
	fi::u8string_view ws_key{};
	fi::u8string_view ws_version{};
	fi::u8string_view accept_encoding{};
	fi::u8string_view range{};
	::std::size_t content_length{};
	bool head{};
	bool keep_alive{};
};

struct target_parts
{
	target_parts() throws = default;
	fi::u8string path;   // normalized, no leading slash
	fi::u8string query;  // raw query without '?'
};

/* --------------------------- small helpers -------------------------- */

constexpr bool ascii_ieq(fi::u8string_view a, fi::u8string_view b) noexcept
{
	if (a.size() != b.size())
	{
		return false;
	}
	for (::std::size_t i{}; i != a.size(); ++i)
	{
		auto x{static_cast<unsigned char>(a[i])};
		auto y{static_cast<unsigned char>(b[i])};
		if (x >= 'A' && x <= 'Z')
		{
			x = static_cast<unsigned char>(x + 32);
		}
		if (y >= 'A' && y <= 'Z')
		{
			y = static_cast<unsigned char>(y + 32);
		}
		if (x != y)
		{
			return false;
		}
	}
	return true;
}

bool has_token(fi::u8string_view list, fi::u8string_view tok) noexcept
{
	::std::size_t i{};
	while (i < list.size())
	{
		while (i < list.size() && (list[i] == u8' ' || list[i] == u8',' || list[i] == u8'\t'))
		{
			++i;
		}
		auto const begin{i};
		while (i < list.size() && list[i] != u8',')
		{
			++i;
		}
		auto const end{i};
		if (ascii_ieq(fi::u8string_view{list.data() + begin, end - begin}, tok))
		{
			return true;
		}
	}
	return false;
}

constexpr int hex_val(char8_t c) noexcept
{
	if (c >= u8'0' && c <= u8'9') return c - u8'0';
	if (c >= u8'a' && c <= u8'f') return c - u8'a' + 10;
	if (c >= u8'A' && c <= u8'F') return c - u8'A' + 10;
	return -1;
}

// Throws std::errc::invalid_argument for a malformed percent escape.
target_parts parse_target(fi::u8string_view raw) throws
{
	target_parts out{};
	::std::size_t end{raw.size()};
	for (::std::size_t i{}; i != raw.size(); ++i)
	{
		if (raw[i] == u8'?')
		{
			end = i;
			out.query.assign(fi::u8string_view{raw.data() + i + 1, raw.size() - i - 1});
			break;
		}
	}
	fi::u8string decoded;
	for (::std::size_t i{}; i != end; ++i)
	{
		char8_t c{raw[i]};
		if (c == u8'%')
		{
			if (i + 2 >= end)
			{
				throw throws ::std::errc::invalid_argument;
			}
			int const hi{hex_val(raw[i + 1])};
			int const lo{hex_val(raw[i + 2])};
			if (hi < 0 || lo < 0)
			{
				throw throws ::std::errc::invalid_argument;
			}
			c = static_cast<char8_t>((hi << 4) | lo);
			i += 2;
		}
		if (c == u8'\\')
		{
			c = u8'/';
		}
		decoded.push_back(c);
	}
	// path.normalize, clamped at the root.
	out.path.clear();
	::std::size_t seg{};
	while (seg < decoded.size())
	{
		auto e{seg};
		while (e < decoded.size() && decoded[e] != u8'/')
		{
			++e;
		}
		auto const piece{fi::u8string_view{decoded.data() + seg, e - seg}};
		if (piece == fi::u8string_view{u8".."})
		{
			if (!out.path.is_empty())
			{
				auto n{out.path.size()};
				while (n != 0 && out.path[n - 1] != u8'/')
				{
					--n;
				}
				out.path.assign(fi::u8string_view{out.path.data(), n == 0 ? 0 : n - 1});
			}
		}
		else if (!piece.is_empty() && piece != fi::u8string_view{u8"."})
		{
			if (!out.path.is_empty())
			{
				out.path.push_back(u8'/');
			}
			out.path.append(piece.data(), piece.size());
		}
		seg = e + 1;
	}
	return out;
}

fi::u8string_view mime_of(fi::u8string_view path) noexcept
{
	struct ent { fi::u8string_view ext, type; };
	static constexpr ent table[]{
		{u8"html", u8"text/html; charset=utf-8"}, {u8"js", u8"text/javascript; charset=utf-8"},
		{u8"mjs", u8"text/javascript; charset=utf-8"}, {u8"css", u8"text/css; charset=utf-8"},
		{u8"json", u8"application/json"}, {u8"wasm", u8"application/wasm"},
		{u8"svg", u8"image/svg+xml"}, {u8"png", u8"image/png"}, {u8"webp", u8"image/webp"},
		{u8"ico", u8"image/x-icon"}, {u8"txt", u8"text/plain; charset=utf-8"},
		{u8"md", u8"text/markdown; charset=utf-8"}, {u8"zip", u8"application/zip"},
		{u8"gz", u8"application/gzip"}, {u8"br", u8"application/octet-stream"}};
	auto dot{path.size()};
	for (::std::size_t i{path.size()}; i != 0;)
	{
		--i;
		if (path[i] == u8'/')
		{
			break;
		}
		if (path[i] == u8'.')
		{
			dot = i + 1;
			break;
		}
	}
	if (dot >= path.size())
	{
		return u8"application/octet-stream";
	}
	auto const ext{fi::u8string_view{path.data() + dot, path.size() - dot}};
	for (auto const &e : table)
	{
		if (ascii_ieq(ext, e.ext))
		{
			return e.type;
		}
	}
	return u8"application/octet-stream";
}

// A predicate; only "does not exist" is swallowed.  Everything else is a
// real failure and continues to travel on the herbception channel.
bool file_exists(fi::u8string_view path) throws
{
	try
	{
		fi::u8native_file f{fi::mnp::os_c_str(path.data()), fi::open_mode::in};
		(void)f;
		return true;
	}
	catch throws(::std::error e)
	{
		if (e.equivalent(::std::errc::no_such_file_or_directory))
		{
			return false;
		}
		throw throws;
	}
}

fi::u8string error_message(::std::error const &e) throws
{
	fi::u8string text;
	fi::u8ostring_ref_fast_io writer{__builtin_addressof(text)};
	fi::io::print(writer, fi::mnp::message(e));
	return text;
}

fi::u8string json_escape(fi::u8string_view s) throws
{
	fi::u8string out;
	fi::u8ostring_ref_fast_io w{__builtin_addressof(out)};
	for (char8_t c : s)
	{
		switch (c)
		{
		case u8'"': fi::io::print(w, u8"\\\""); break;
		case u8'\\': fi::io::print(w, u8"\\\\"); break;
		case u8'\n': fi::io::print(w, u8"\\n"); break;
		case u8'\r': fi::io::print(w, u8"\\r"); break;
		case u8'\t': fi::io::print(w, u8"\\t"); break;
		default: fi::io::print(w, ::fast_io::mnp::chvw(c));
		}
	}
	return out;
}

fi::u8string json_error(::std::error const &e) throws
{
	auto const msg{error_message(e)};
	auto const esc{json_escape(fi::u8string_view{msg.data(), msg.size()})};
	return fi::u8concat_fast_io(u8"{\"ok\":false,\"error\":\"", esc, u8"\"}");
}

fi::u8string workspace_path(server_cfg const &cfg, fi::u8string_view rel) throws
{
	fi::u8string p{cfg.workspace};
	if (!p.is_empty() && p[p.size() - 1] != u8'/')
	{
		p.push_back(u8'/');
	}
	if (!rel.is_empty())
	{
		p.append(rel.data(), rel.size());
	}
	return p;
}

// Extract ?path=... from a query string.  Throws only on allocation failure.
fi::u8string query_path(fi::u8string_view query) throws
{
	for (::std::size_t i{}; i + 5 <= query.size(); ++i)
	{
		if (fi::u8string_view{query.data() + i, 5} == fi::u8string_view{u8"path="})
		{
			return fi::u8string{fi::u8string_view{query.data() + i + 5, query.size() - i - 5}};
		}
	}
	return {};
}

/* ---------------------------- responses ----------------------------- */

fi::io_async_task<> send_simple(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
								unsigned code, fi::u8string_view phrase, fi::u8string_view body,
								request const &req, bool close) throws
{
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 ", code, u8" ", phrase,
		u8"\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ", body.size(),
		u8"\r\nConnection: ", (close || !req.keep_alive) ? fi::u8string_view{u8"close"}
														: fi::u8string_view{u8"keep-alive"},
		u8"\r\n\r\n");
	if (!req.head && !body.is_empty())
	{
		co_await fi::io::async_print(sched, {}, sock, body);
	}
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

fi::io_async_task<> send_json(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
							  fi::u8string_view json, request const &req, unsigned code = 200,
							  fi::u8string_view phrase = u8"OK") throws
{
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 ", code, u8" ", phrase,
		u8"\r\nContent-Type: application/json; charset=utf-8"
		u8"\r\nCache-Control: no-store\r\nContent-Length: ", json.size(),
		u8"\r\nConnection: ",
		req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
		u8"\r\n\r\n");
	if (!req.head)
	{
		co_await fi::io::async_print(sched, {}, sock, json);
	}
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

/* ----------------------------- static ------------------------------- */

fi::io_async_task<> serve_static(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
								 server_cfg const &cfg, fi::u8string_view rel, request const &req) throws
{
	fi::u8string path{cfg.root_path};
	if (!path.is_empty() && path[path.size() - 1] != u8'/')
	{
		path.push_back(u8'/');
	}
	if (rel.is_empty())
	{
		path.append(u8"index.html");
	}
	else
	{
		path.append(rel.data(), rel.size());
	}

	fi::u8string chosen{path};
	fi::u8string_view content_encoding{};
	if (has_token(req.accept_encoding, u8"br"))
	{
		auto candidate{fi::u8concat_fast_io(path, u8".br")};
		if (file_exists(sv(candidate)))
		{
			chosen = ::std::move(candidate);
			content_encoding = u8"br";
		}
	}
	else if (has_token(req.accept_encoding, u8"gzip"))
	{
		auto candidate{fi::u8concat_fast_io(path, u8".gz")};
		if (file_exists(sv(candidate)))
		{
			chosen = ::std::move(candidate);
			content_encoding = u8"gzip";
		}
	}

	fi::u8native_file f{fi::mnp::os_c_str(chosen.data()),
						fi::open_mode::in | fi::open_mode::no_block};
	auto const st{fi::status(f)};
	if (st.type == fi::file_type::directory)
	{
		co_await send_simple(sched, sock, 404, u8"Not Found", u8"not found", req, false);
		co_return;
	}
	auto const length{st.size};
	fi::u8string encoding_header;
	if (!content_encoding.is_empty())
	{
		encoding_header = fi::u8concat_fast_io(u8"\r\nContent-Encoding: ", content_encoding);
	}
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 200 OK\r\nContent-Type: ", mime_of(sv(path)),
		u8"\r\nContent-Length: ", length, sv(encoding_header),
		u8"\r\nCache-Control: no-cache"
		u8"\r\nService-Worker-Allowed: /\r\nConnection: ",
		req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
		u8"\r\n\r\n");
	if (!req.head && length != 0)
	{
		co_await fop::async_transmit_all_bytes(sched, {}, sock, {}, f, {},
											   fi::size_t_opt{static_cast<::std::size_t>(length)});
	}
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

/* ------------------------------ API --------------------------------- */

// GET /api/list?path=...
fi::io_async_task<> api_list(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
							 server_cfg const &cfg, target_parts const &t, request const &req) throws
{
	try
	{
		auto const rel{query_path(sv(t.query))};
		auto decoded{parse_target(fi::u8string_view{rel.data(), rel.size()})};
		fi::u8string dir{workspace_path(cfg, sv(decoded.path))};
		fi::u8string json{u8"{\"path\":"};
		{
			auto esc{json_escape(sv(decoded.path))};
			json.push_back(u8'"');
			json.append(esc.data(), esc.size());
			json.append(u8"\",\"entries\":[", 13);
		}
		bool first{true};
		fi::u8native_file d{fi::mnp::os_c_str(dir.data()),
							fi::open_mode::in | fi::open_mode::directory};
		for (auto const &ent : fi::current(fi::at(d)))
		{
			if (fi::is_dot(ent))
			{
				continue;
			}
			auto const name{fi::u8filename(ent)};
			bool const isdir{fi::type(ent) == fi::file_type::directory};
			if (!first)
			{
				json.push_back(u8',');
			}
			first = false;
			auto esc{json_escape(fi::u8string_view{name.data(), name.size()})};
			json.append(u8"{\"name\":\"", 9);
			json.append(esc.data(), esc.size());
			json.append(u8"\",\"dir\":", 8);
			json.append(isdir ? u8"true" : u8"false", isdir ? 4 : 5);
			json.push_back(u8'}');
		}
		json.append(u8"]}", 2);
		co_await send_json(sched, sock, sv(json), req);
	}
	catch throws(::std::error e)
	{
		auto const body{json_error(e)};
		co_await send_json(sched, sock, sv(body), req, 500, u8"Internal Server Error");
	}
}

// GET/PUT /api/file?path=...
fi::io_async_task<> api_file(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
							 server_cfg const &cfg, target_parts const &t, request const &req) throws
{
	auto const rel{query_path(sv(t.query))};
	auto decoded{parse_target(fi::u8string_view{rel.data(), rel.size()})};
	auto path{workspace_path(cfg, sv(decoded.path))};
	if (decoded.path.is_empty())
	{
		co_await send_simple(sched, sock, 400, u8"Bad Request", u8"bad path", req, true);
		co_return;
	}
	if (req.method == fi::u8string_view{u8"PUT"})
	{
		fi::u8string body;
		body.resize(req.content_length);
		if (req.content_length != 0)
		{
			co_await fop::async_pread_all_bytes(
				sched, {}, sock, reinterpret_cast<::std::byte *>(body.data()), body.size(), {});
		}
		try
		{
			fi::u8native_file f{fi::mnp::os_c_str(path.data()),
								fi::open_mode::out | fi::open_mode::creat | fi::open_mode::trunc};
			fop::write_all_bytes(f, reinterpret_cast<::std::byte const *>(body.data()),
								 body.size());
		}
		catch throws(::std::error e)
		{
			auto const error{json_error(e)};
			co_await send_json(sched, sock, sv(error), req, 500, u8"Internal Server Error");
			co_return;
		}
		co_await send_json(sched, sock, u8"{\"ok\":true}", req);
		co_return;
	}
	try
	{
		fi::u8native_file f{fi::mnp::os_c_str(path.data()),
							fi::open_mode::in | fi::open_mode::no_block};
		auto const st{fi::status(f)};
		co_await fi::io::async_print(
			sched, {}, sock, u8"HTTP/1.1 200 OK\r\nContent-Type: ", mime_of(sv(decoded.path)),
			u8"\r\nCache-Control: no-store\r\nContent-Length: ", st.size,
			u8"\r\nConnection: ",
			req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
			u8"\r\n\r\n");
		if (!req.head && st.size != 0)
		{
			co_await fop::async_transmit_all_bytes(
				sched, {}, sock, {}, f, {},
				fi::size_t_opt{static_cast<::std::size_t>(st.size)});
		}
		co_await fop::async_output_stream_flush(sched, {}, sock);
	}
	catch throws(::std::error e)
	{
		if (e.equivalent(::std::errc::no_such_file_or_directory))
		{
			co_await send_simple(sched, sock, 404, u8"Not Found", u8"not found", req, false);
		}
		else
		{
			auto const body{json_error(e)};
			co_await send_json(sched, sock, sv(body), req, 500, u8"Internal Server Error");
		}
	}
}

/* --------------------------- terminal ------------------------------ */

constexpr fi::posix_statx_timestamp_opt timeout_milliseconds(::std::uint_least64_t ms) noexcept
{
	return fi::posix_statx_timestamp_opt{
		fi::posix_timespec64{static_cast<::std::int_least64_t>(ms / 1000u),
							 static_cast<::std::uint_least32_t>((ms % 1000u) * 1000000u)},
		true};
}

fi::io_async_task<> async_write_all(fi::io_async_observer sched, auto out,
									::std::byte const *data, ::std::size_t len) throws
{
	while (len != 0)
	{
		auto const written{
			co_await fop::async_pwrite_some_bytes(sched, {}, out, data, len, {})};
		if (written == 0)
		{
			throw throws ::std::errc::broken_pipe;
		}
		data += written;
		len -= written;
	}
}

struct ws_frame
{
	ws_frame() throws = default;
	fi::websocket_opcode op{fi::websocket_opcode::continuation};
	bool fin{};
	fi::vector<::std::byte> payload;
};

constexpr ::std::uint_least64_t ws_max_frame{64u << 10};

// Reads one complete WebSocket frame out of an incrementally fed buffer.
// Nothing here blocks: the caller fills the buffer with a timed async read and
// retries `next()`.  This keeps the PTY and the socket pumped by one coroutine
// without a second thread.
struct ws_parser
{
	ws_parser() noexcept = default;
	::std::byte buf[ws_max_frame]{};
	::std::size_t len{};

	void feed(::std::byte const *data, ::std::size_t n) throws
	{
		if (n > sizeof(buf) - len)
		{
			throw throws ::std::errc::value_too_large;
		}
		::std::memcpy(buf + len, data, n);
		len += n;
	}

	bool next(ws_frame &frame) throws
	{
		if (len < 2)
		{
			return false;
		}
		auto const b0{static_cast<::std::uint_least8_t>(buf[0])};
		auto const b1{static_cast<::std::uint_least8_t>(buf[1])};
		bool const masked{(b1 & 0x80u) != 0};
		::std::size_t header{2};
		::std::uint_least64_t payload_len{static_cast<::std::uint_least64_t>(b1 & 0x7Fu)};
		if (payload_len == 126)
		{
			if (len < 4)
			{
				return false;
			}
			payload_len = (static_cast<::std::uint_least64_t>(
							   static_cast<::std::uint_least8_t>(buf[2]))
						   << 8) |
						  static_cast<::std::uint_least8_t>(buf[3]);
			header = 4;
		}
		else if (payload_len == 127)
		{
			if (len < 10)
			{
				return false;
			}
			payload_len = 0;
			for (::std::size_t i{}; i != 8; ++i)
			{
				payload_len = (payload_len << 8) |
							  static_cast<::std::uint_least8_t>(buf[2 + i]);
			}
			header = 10;
		}
		if (payload_len > ws_max_frame)
		{
			throw throws ::std::errc::value_too_large;
		}
		::std::size_t const mask_off{header};
		if (masked)
		{
			header += 4;
		}
		::std::size_t const total{header + static_cast<::std::size_t>(payload_len)};
		if (len < total)
		{
			return false;
		}
		frame.fin = (b0 & 0x80u) != 0;
		frame.op = static_cast<fi::websocket_opcode>(b0 & 0x0Fu);
		frame.payload.resize(static_cast<::std::size_t>(payload_len));
		if (payload_len != 0)
		{
			::std::memcpy(frame.payload.data(), buf + header,
						  static_cast<::std::size_t>(payload_len));
			if (masked)
			{
				for (::std::size_t i{}; i != frame.payload.size(); ++i)
				{
					frame.payload[i] = static_cast<::std::byte>(
						static_cast<::std::uint_least8_t>(frame.payload[i]) ^
						static_cast<::std::uint_least8_t>(buf[mask_off + i % 4]));
				}
			}
		}
		::std::memmove(buf, buf + total, len - total);
		len -= total;
		return true;
	}
};

fi::io_async_task<> ws_send_frame(fi::io_async_observer sched, auto out,
								  bool fin, fi::websocket_opcode op,
								  ::std::byte const *data, ::std::size_t len) throws
{
	::std::byte header[10];
	auto const hn{fi::websocket_encode_frame_header(header, fin, op, len)};
	co_await async_write_all(sched, out, header, hn);
	if (len != 0)
	{
		co_await async_write_all(sched, out, data, len);
	}
}

// Fork the shell onto a PTY.  Every syscall that can fail uses errno only to
// build the herbception; no caller ever sees an error code.
fi::u8posix_file spawn_pty(fi::u8string_view shell, pid_t &child) throws
{
	int master{::posix_openpt(O_RDWR | O_NOCTTY)};
	if (master < 0)
	{
		::fast_io::throw_posix_error();
	}
	if (::grantpt(master) != 0 || ::unlockpt(master) != 0)
	{
		auto const err{errno};
		::close(master);
		::fast_io::throw_posix_error(err);
	}
	char *slave_name{::ptsname(master)};
	if (slave_name == nullptr)
	{
		auto const err{errno};
		::close(master);
		::fast_io::throw_posix_error(err);
	}
	pid_t const pid{::fork()};
	if (pid < 0)
	{
		auto const err{errno};
		::close(master);
		::fast_io::throw_posix_error(err);
	}
	if (pid == 0)
	{
		(void)::setsid();
		int const slave{::open(slave_name, O_RDWR)};
		if (slave < 0)
		{
			::_exit(1);
		}
		(void)::dup2(slave, 0);
		(void)::dup2(slave, 1);
		(void)::dup2(slave, 2);
		if (slave > 2)
		{
			::close(slave);
		}
		::close(master);
		char *argv[]{const_cast<char *>(reinterpret_cast<char const *>(shell.data())), nullptr};
		::execvp(argv[0], argv);
		::_exit(127);
	}
	child = pid;
	return fi::u8posix_file{master};
}

fi::io_async_task<> ws_terminal(fi::io_async_observer sched, fi::u8iobuf_socket_file &sock,
								request const &req) throws
{
	char8_t accept[fi::websocket_accept_key_size];
	fi::websocket_accept_key(accept, req.ws_key.data(), req.ws_key.size());
	co_await fi::io::async_print(
		sched, {}, sock,
		u8"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
		u8"Sec-WebSocket-Accept: ",
		fi::u8string_view{accept, fi::websocket_accept_key_size}, u8"\r\n\r\n");
	co_await fop::async_output_stream_flush(sched, {}, sock);

	auto const &shell_env{::getenv("SHELL")};
	fi::u8string shell;
	if (shell_env != nullptr)
	{
		shell.assign(fi::u8string_view{reinterpret_cast<char8_t const *>(shell_env),
									   ::std::strlen(shell_env)});
	}
	else
	{
		shell.assign(u8"/bin/sh");
	}

	pid_t child{};
	fi::u8posix_file master{spawn_pty(fi::u8string_view{shell.data(), shell.size()}, child)};
	fi::u8posix_io_observer const master_io{master.fd};
	fi::u8posix_socket_io_observer const sock_io{sock.handle.fd};

	// Both directions are driven by the same coroutine.  Every read carries a
	// short timeout, so neither direction can starve the other and there is no
	// std::thread anywhere in the pump.
	bool running{true};
	ws_parser parser{};
	::std::byte rbuf[16384];
	while (running)
	{
		try
		{
			auto const n{co_await fop::async_pread_some_bytes(
				sched, timeout_milliseconds(8), master_io, rbuf, sizeof(rbuf), {})};
			if (n == 0)
			{
				running = false;
			}
			else
			{
				co_await ws_send_frame(sched, sock_io, true, fi::websocket_opcode::binary,
									   rbuf, n);
			}
		}
		catch throws(::std::error e)
		{
			if (!e.equivalent(::std::errc::timed_out))
			{
				running = false;
			}
		}
		if (!running)
		{
			break;
		}
		try
		{
			auto const n{co_await fop::async_pread_some_bytes(
				sched, timeout_milliseconds(8), sock_io, rbuf, sizeof(rbuf), {})};
			if (n == 0)
			{
				running = false;
			}
			else
			{
				parser.feed(rbuf, n);
			}
		}
		catch throws(::std::error e)
		{
			if (!e.equivalent(::std::errc::timed_out))
			{
				running = false;
			}
		}
		if (!running)
		{
			break;
		}
		ws_frame frame{};
		while (running && parser.next(frame))
		{
			switch (frame.op)
			{
			case fi::websocket_opcode::text:
			case fi::websocket_opcode::binary:
			case fi::websocket_opcode::continuation:
				if (!frame.payload.is_empty())
				{
					co_await async_write_all(sched, master_io, frame.payload.data(),
											 frame.payload.size());
				}
				break;
			case fi::websocket_opcode::ping:
				co_await ws_send_frame(sched, sock_io, true, fi::websocket_opcode::pong,
									   frame.payload.data(), frame.payload.size());
				break;
			case fi::websocket_opcode::close:
				running = false;
				break;
			default:
				break;
			}
		}
	}

	::kill(child, SIGKILL);
	int status{};
	(void)::waitpid(child, &status, 0);
}

/* ----------------------------- HTTP -------------------------------- */

fi::io_async_task<> session(fi::io_async_observer sched, fi::u8iobuf_socket_file sock,
							server_cfg cfg) throws
{
	try
	{
		auto const peer{fi::getpeername(sock.handle).address};
		if (!fi::lna_allows(peer, cfg.lna_max))
		{
			request denied{};
			co_await send_simple(sched, sock, 403, u8"Forbidden",
								 u8"This server only accepts local-network peers.", denied, true);
			co_return;
		}
	}
	catch throws(::std::error)
	{
		co_return;
	}

	for (;;)
	{
		try
		{
			fi::u8http_header_buffer hdr{};
			co_await fi::io::async_scan(sched, {}, sock, hdr);
			request req{};
			auto const m{hdr.request()};
			auto const t{hdr.code()};
			auto const v{hdr.reason()};
			req.method = fi::u8string_view{m.data(), m.size()};
			req.target = fi::u8string_view{t.data(), t.size()};
			req.version = fi::u8string_view{v.data(), v.size()};
			req.head = req.method == fi::u8string_view{u8"HEAD"};
			bool bad_header{};
			for (auto [key, value] : line_generator(hdr))
			{
				auto const k{fi::u8string_view{key.data(), key.size()}};
				auto const val{fi::u8string_view{value.data(), value.size()}};
				if (ascii_ieq(k, u8"connection")) req.connection = val;
				else if (ascii_ieq(k, u8"upgrade")) req.upgrade = val;
				else if (ascii_ieq(k, u8"sec-websocket-key")) req.ws_key = val;
				else if (ascii_ieq(k, u8"sec-websocket-version")) req.ws_version = val;
				else if (ascii_ieq(k, u8"accept-encoding")) req.accept_encoding = val;
				else if (ascii_ieq(k, u8"range")) req.range = val;
				else if (ascii_ieq(k, u8"content-length"))
				{
					try
					{
						req.content_length = fi::u8to<::std::size_t>(val);
					}
					catch throws(::std::error)
					{
						bad_header = true;
					}
				}
			}
			if (bad_header)
			{
				co_await send_simple(sched, sock, 400, u8"Bad Request", u8"bad Content-Length",
									 req, true);
				co_return;
			}
			req.keep_alive = req.version == fi::u8string_view{u8"HTTP/1.0"}
								 ? ascii_ieq(req.connection, u8"keep-alive")
								 : !ascii_ieq(req.connection, u8"close");

			target_parts parts{};
			try
			{
				parts = parse_target(req.target);
			}
			catch throws(::std::error)
			{
				co_await send_simple(sched, sock, 400, u8"Bad Request", u8"bad request", req, true);
				co_return;
			}

			bool const is_ws{req.method == fi::u8string_view{u8"GET"} &&
							 parts.path == fi::u8string_view{u8"ws/term"} &&
							 ascii_ieq(req.upgrade, u8"websocket") &&
							 !req.ws_key.is_empty() &&
							 req.ws_version == fi::u8string_view{u8"13"}};
			if (is_ws)
			{
				co_await ws_terminal(sched, sock, req);
				co_return;
			}
			if (parts.path == fi::u8string_view{u8"api/ping"})
			{
				co_await send_json(sched, sock, u8"{\"ok\":true,\"server\":\"pwa-code\"}", req);
			}
			else if (parts.path == fi::u8string_view{u8"api/list"})
			{
				co_await api_list(sched, sock, cfg, parts, req);
			}
			else if (parts.path == fi::u8string_view{u8"api/file"})
			{
				co_await api_file(sched, sock, cfg, parts, req);
			}
			else if (req.method == fi::u8string_view{u8"GET"} ||
					 req.method == fi::u8string_view{u8"HEAD"})
			{
				try
				{
					co_await serve_static(sched, sock, cfg, sv(parts.path), req);
				}
				catch throws(::std::error e)
				{
					if (e.equivalent(::std::errc::no_such_file_or_directory))
					{
						co_await send_simple(sched, sock, 404, u8"Not Found", u8"not found", req,
											 false);
					}
					else
					{
						auto const body{json_error(e)};
						co_await send_json(sched, sock, sv(body), req, 500,
										   u8"Internal Server Error");
					}
				}
			}
			else
			{
				co_await send_simple(sched, sock, 405, u8"Method Not Allowed", u8"", req, false);
			}
			if (!req.keep_alive)
			{
				co_return;
			}
		}
		catch throws(::std::error e)
		{
			if (e.equivalent(::std::errc::no_such_file_or_directory) ||
				e.is_code_of<::std::parse_errc>())
			{
				co_return;
			}
			fi::io::perrln(e);
			co_return;
		}
	}
}

fi::io_async_task<> accept_loop(fi::io_async_observer sched, fi::u8native_socket_io_observer listener,
								server_cfg cfg) throws
{
	for (;;)
	{
		fi::u8native_socket_file accepted{
			co_await fop::async_accept(sched, {}, listener, fi::open_mode::no_block)};
		session(sched, fi::u8iobuf_socket_file{::std::move(accepted)}, cfg).detach();
	}
}

// Kept outside main() so argument failures stay on the herbception channel
// without a direct `throw` inside a `noexcept` function.
[[noreturn]] inline void invalid_arguments() throws
{
	throw throws ::std::errc::invalid_argument;
}

} // namespace

int main(int argc, char const **argv) noexcept
{
	try
	{
	server_cfg cfg{};
	fi::u8string root;
	fi::u8string workspace;
	for (int i{1}; i != argc; ++i)
	{
		fi::u8cstring_view const arg{fi::mnp::os_c_str(
			reinterpret_cast<char8_t const *>(argv[i]))};
		if (arg == fi::u8cstring_view{u8"-p"} || arg == fi::u8cstring_view{u8"--port"})
		{
			if (++i == argc)
			{
				invalid_arguments();
			}
			cfg.port = static_cast<::std::uint_least16_t>(
				fi::u8to<unsigned>(fi::mnp::os_c_str(reinterpret_cast<char8_t const *>(argv[i]))));
		}
		else if (arg == fi::u8cstring_view{u8"-w"} || arg == fi::u8cstring_view{u8"--workspace"})
		{
			if (++i == argc)
			{
				invalid_arguments();
			}
			workspace.assign(fi::u8string_view{reinterpret_cast<char8_t const *>(argv[i]),
											   ::std::strlen(argv[i])});
		}
		else if (arg == fi::u8cstring_view{u8"--lna"})
		{
			if (++i == argc)
			{
				invalid_arguments();
			}
			fi::u8cstring_view const val{fi::mnp::os_c_str(
				reinterpret_cast<char8_t const *>(argv[i]))};
			auto const rule{fi::lna_parse(val.data(), val.data() + val.size())};
			if (rule.kind != fi::lna_rule_kind::space)
			{
				invalid_arguments();
			}
			cfg.lna_max = rule.space;
		}
		else if (arg == fi::u8cstring_view{u8"-h"} || arg == fi::u8cstring_view{u8"--help"})
		{
			fi::io::perr("Usage: pwacode-server [docs-root] [-p port] [-w workspace] "
						 "[--lna loopback|local|public]\n");
			return 0;
		}
		else if (root.is_empty())
		{
			root.assign(fi::u8string_view{reinterpret_cast<char8_t const *>(argv[i]),
									   ::std::strlen(argv[i])});
		}
	}
	if (root.is_empty())
	{
		if (file_exists(u8"./docs"))
		{
			root.assign(u8"./docs");
		}
		else
		{
			root.assign(u8"./source");
		}
	}
	if (workspace.is_empty())
	{
		workspace.assign(u8".");
	}
	cfg.root_path = root;
	cfg.workspace = workspace;

	fi::net_service service;
	fi::io_async_scheduler scheduler{fi::io_async};
	fi::u8native_socket_file listener{fi::tcp_listen(cfg.port, fi::open_mode::no_block)};
	fi::io::perr("pwa-code server on http://127.0.0.1:", cfg.port, " (root=",
				 ::fast_io::mnp::os_c_str(reinterpret_cast<char const *>(root.c_str())),
				 ", workspace=",
				 ::fast_io::mnp::os_c_str(reinterpret_cast<char const *>(workspace.c_str())),
				 ")\n");
	if (fi::native_ifaddrs_file ifas{fi::ifaddrs_enumerate}; ifas)
	{
		for (auto const ent : ifas)
		{
			if (fi::family(ent) != fi::sock_family::inet)
			{
				continue;
			}
			auto const addr{fi::address(ent)};
			if (addr.isv4 && addr.address.v4.address[0] != 127)
			{
				fi::io::perr("  http://", fi::ip{addr, cfg.port}, "\n");
			}
		}
	}
	for (;;)
	{
		try
		{
			auto acceptor{accept_loop(scheduler, listener, cfg)};
			acceptor.resume();
			while (!acceptor.done())
			{
				fi::io_async_wait(scheduler);
			}
			acceptor.rethrow_if_error();
		}
		catch throws(::std::error e)
		{
			fi::io::perrln(e);
		}
	}
	}
	catch throws(::std::error e)
	{
		fi::io::perrln(e);
		return 1;
	}
}
