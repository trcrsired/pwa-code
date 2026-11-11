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
// Scheduler: io_uring on Linux when the kernel allows it, otherwise fast_io's
// POSIX thread pool (Android, seccomp sandboxes, --no-uring).  The PTY master
// is non-blocking on the pool so its short read deadlines still let one
// coroutine alternate shell and socket traffic.
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
#include <stdlib.h>

#if defined(_WIN32)
// The win32 surface (kernel32 declarations, HANDLE observers, IOCP async) is
// already provided by fast_io; only the ConPTY entry points are missing and are
// resolved through GetProcAddress below.
#else
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#endif

namespace fi = ::fast_io;
namespace fop = ::fast_io::operations;

namespace
{

// Set before the accept loop starts.  The thread-pool async backend honours a
// read deadline by polling a NON-BLOCKING descriptor: a blocking read parks the
// worker inside the kernel where it cannot be interrupted, which would freeze
// the terminal pump's alternating shell/socket reads.  io_uring does not need
// this (it cancels the op itself), so the flag stays false there.
bool pty_nonblocking{};

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
	bool no_uring{};
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

// Remote mounts are fetched by a browser that may be served from another
// origin (GitHub Pages, a file:// snapshot, another machine), so every response
// carries permissive CORS headers and OPTIONS preflights are answered directly.
inline constexpr char8_t cors_text[]{
	u8"Access-Control-Allow-Origin: *\r\n"
	u8"Access-Control-Allow-Methods: GET, HEAD, PUT, OPTIONS\r\n"
	u8"Access-Control-Allow-Headers: Content-Type, Access-Control-Request-Private-Network\r\n"
	// A PWA served from a public origin (GitHub Pages) may mount a server on
	// the user's LAN or loopback.  Chrome's Private Network Access preflight
	// only succeeds when the private endpoint opts in.
	u8"Access-Control-Allow-Private-Network: true\r\n"
	u8"Access-Control-Max-Age: 86400\r\n"};

inline fi::u8string_view cors_headers() noexcept
{
	return fi::u8string_view{cors_text, sizeof(cors_text) - 1};
}

template <typename Sched>
fi::io_async_task<> send_preflight(Sched sched, fi::u8iobuf_socket_file &sock,
								   request const &req) throws
{
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 204 No Content\r\n", cors_headers(),
		u8"Content-Length: 0\r\nConnection: ",
		req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
		u8"\r\n\r\n");
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

template <typename Sched>
fi::io_async_task<> send_simple(Sched sched, fi::u8iobuf_socket_file &sock,
								unsigned code, fi::u8string_view phrase, fi::u8string_view body,
								request const &req, bool close) throws
{
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 ", code, u8" ", phrase,
		u8"\r\nContent-Type: text/plain; charset=utf-8\r\n", cors_headers(),
		u8"Content-Length: ", body.size(),
		u8"\r\nConnection: ", (close || !req.keep_alive) ? fi::u8string_view{u8"close"}
														: fi::u8string_view{u8"keep-alive"},
		u8"\r\n\r\n");
	if (!req.head && !body.is_empty())
	{
		co_await fi::io::async_print(sched, {}, sock, body);
	}
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

template <typename Sched>
fi::io_async_task<> send_json(Sched sched, fi::u8iobuf_socket_file &sock,
							  fi::u8string_view json, request const &req, unsigned code = 200,
							  fi::u8string_view phrase = u8"OK") throws
{
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 ", code, u8" ", phrase,
		u8"\r\nContent-Type: application/json; charset=utf-8\r\n", cors_headers(),
		u8"Cache-Control: no-store\r\nContent-Length: ", json.size(),
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

template <typename Sched>
fi::io_async_task<> serve_static(Sched sched, fi::u8iobuf_socket_file &sock,
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

	{
		fi::u8native_file probe{fi::mnp::os_c_str(chosen.data()),
								fi::open_mode::in | fi::open_mode::no_block};
		auto const st{fi::status(probe)};
		if (st.type == fi::file_type::directory)
		{
			co_await send_simple(sched, sock, 404, u8"Not Found", u8"not found", req, false);
			co_return;
		}
	}
	// Map the response body instead of looping over pread.  The loader keeps
	// the mapping alive for the duration of the coroutine, and the socket
	// write becomes one scatter from the page cache.
	fi::native_file_loader loader{fi::mnp::os_c_str(chosen.data())};
	auto const length{loader.size()};
	fi::u8string encoding_header;
	if (!content_encoding.is_empty())
	{
		encoding_header = fi::u8concat_fast_io(u8"\r\nContent-Encoding: ", content_encoding);
	}
	co_await fi::io::async_print(
		sched, {}, sock, u8"HTTP/1.1 200 OK\r\nContent-Type: ", mime_of(sv(path)),
		u8"\r\nContent-Length: ", length, sv(encoding_header), u8"\r\n", cors_headers(),
		u8"Cache-Control: no-cache"
		u8"\r\nService-Worker-Allowed: /\r\nConnection: ",
		req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
		u8"\r\n\r\n");
	if (!req.head && length != 0)
	{
		co_await fop::async_pwrite_all_bytes(
			sched, {}, sock, reinterpret_cast<::std::byte const *>(loader.data()), length, {});
	}
	co_await fop::async_output_stream_flush(sched, {}, sock);
}

/* ------------------------------ API --------------------------------- */

// GET /api/list?path=...
template <typename Sched>
fi::io_async_task<> api_list(Sched sched, fi::u8iobuf_socket_file &sock,
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
template <typename Sched>
fi::io_async_task<> api_file(Sched sched, fi::u8iobuf_socket_file &sock,
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
			// This is the HTTP request body on the socket, not a filesystem
			// read; file responses use native_file_loader below.
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
		{
			fi::u8native_file probe{fi::mnp::os_c_str(path.data()),
									fi::open_mode::in | fi::open_mode::no_block};
			auto const st{fi::status(probe)};
			if (st.type == fi::file_type::directory)
			{
				co_await send_simple(sched, sock, 404, u8"Not Found", u8"not found", req, false);
				co_return;
			}
		}
		fi::native_file_loader loader{fi::mnp::os_c_str(path.data())};
		auto const length{loader.size()};
		co_await fi::io::async_print(
			sched, {}, sock, u8"HTTP/1.1 200 OK\r\nContent-Type: ", mime_of(sv(decoded.path)),
			u8"\r\nCache-Control: no-store\r\n", cors_headers(), u8"Content-Length: ", length,
			u8"\r\nConnection: ",
			req.keep_alive ? fi::u8string_view{u8"keep-alive"} : fi::u8string_view{u8"close"},
			u8"\r\n\r\n");
		if (!req.head && length != 0)
		{
			co_await fop::async_pwrite_all_bytes(
				sched, {}, sock, reinterpret_cast<::std::byte const *>(loader.data()), length, {});
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

template <typename Sched>
fi::io_async_task<> async_write_all(Sched sched, auto out,
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

template <typename Sched>
fi::io_async_task<> ws_send_frame(Sched sched, auto out,
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

/* --------------------------- child process --------------------------- */

// A shell attached to a pseudo terminal.  POSIX forks a pty(4) slave; Windows
// opens a ConPTY whose ends are overlapped named pipes, so the same async pump
// reads console output and writes keystrokes.  Nothing here blocks and nothing
// spawns a thread: the IOCP scheduler owns both directions.
struct terminal_process
{
#if defined(_WIN32)
	void *process{};
	void *console{};
	void *input{};
	void *output{};
#else
	pid_t child{};
	fi::u8posix_file master{};
#endif
};

// Fork the shell onto a PTY.  Every syscall that can fail uses errno only to
// build the herbception; no caller ever sees an error code.
#if defined(_WIN32)

namespace win32 = ::fast_io::win32;

// kernel32 does not surface PeekNamedPipe through fast_io; the console pump only
// needs the byte count, so declare the one entry point it uses.
extern "C" __declspec(dllimport) int __stdcall PeekNamedPipe(
	void *, void *, ::std::uint_least32_t, ::std::uint_least32_t *, ::std::uint_least32_t *,
	::std::uint_least32_t *) noexcept;

constexpr ::std::uint_least32_t pipe_access_inbound{0x00000001u};
constexpr ::std::uint_least32_t pipe_access_outbound{0x00000002u};
constexpr ::std::uint_least32_t file_flag_overlapped{0x40000000u};
constexpr ::std::uint_least32_t generic_read{0x80000000u};
constexpr ::std::uint_least32_t generic_write{0x40000000u};
constexpr ::std::uint_least32_t extended_startupinfo_present{0x00080000u};
constexpr ::std::size_t proc_thread_attribute_pseudoconsole{0x00020016u};
inline void *invalid_handle_value() noexcept
{
	return reinterpret_cast<void *>(static_cast<::std::intptr_t>(-1));
}

struct win32_coord
{
	::std::int_least16_t x;
	::std::int_least16_t y;
};

struct startupinfoex_w
{
	win32::startupinfow startup;
	void *attributes;
};

// ConPTY exists on Windows 10 1809+.  Resolving the entry points dynamically
// keeps the server loadable on older systems; the terminal then reports that it
// is unavailable instead of the binary failing to load.
struct conpty_api
{
	long(__stdcall *create)(win32_coord, void *, void *, ::std::uint_least32_t, void **);
	long(__stdcall *resize)(void *, win32_coord);
	void(__stdcall *close_console)(void *);
	int(__stdcall *init_attributes)(void *, ::std::uint_least32_t, ::std::uint_least32_t,
									::std::size_t *);
	int(__stdcall *update_attribute)(void *, ::std::uint_least32_t, ::std::size_t, void *,
									 ::std::size_t, void *, ::std::size_t *);
	void(__stdcall *delete_attributes)(void *);
};

conpty_api load_conpty_api() throws
{
	void *const module{win32::GetModuleHandleW(u"kernel32.dll")};
	if (module == nullptr)
	{
		::fast_io::throw_win32_error();
	}
	conpty_api api{};
	api.create = reinterpret_cast<decltype(api.create)>(
		win32::GetProcAddress(module, "CreatePseudoConsole"));
	api.resize = reinterpret_cast<decltype(api.resize)>(
		win32::GetProcAddress(module, "ResizePseudoConsole"));
	api.close_console = reinterpret_cast<decltype(api.close_console)>(
		win32::GetProcAddress(module, "ClosePseudoConsole"));
	api.init_attributes = reinterpret_cast<decltype(api.init_attributes)>(
		win32::GetProcAddress(module, "InitializeProcThreadAttributeList"));
	api.update_attribute = reinterpret_cast<decltype(api.update_attribute)>(
		win32::GetProcAddress(module, "UpdateProcThreadAttribute"));
	api.delete_attributes = reinterpret_cast<decltype(api.delete_attributes)>(
		win32::GetProcAddress(module, "DeleteProcThreadAttributeList"));
	if (api.create == nullptr || api.close_console == nullptr || api.init_attributes == nullptr ||
		api.update_attribute == nullptr || api.delete_attributes == nullptr)
	{
		throw throws ::std::errc::function_not_supported;
	}
	return api;
}

// Owning handle for the duration of a spawn attempt.
struct handle_guard
{
	void *handle{};
	explicit handle_guard(void *h = nullptr) noexcept : handle(h) {}
	handle_guard(handle_guard const &) = delete;
	handle_guard &operator=(handle_guard const &) = delete;
	~handle_guard() noexcept
	{
		if (handle != nullptr)
		{
			win32::CloseHandle(handle);
		}
	}
	void *release() noexcept
	{
		void *const h{handle};
		handle = nullptr;
		return h;
	}
};

struct attribute_guard
{
	void *list{};
	conpty_api const *api{};
	~attribute_guard() noexcept
	{
		if (list != nullptr)
		{
			api->delete_attributes(list);
			::free(list);
		}
	}
};

struct console_guard
{
	void *console{};
	conpty_api const *api{};
	~console_guard() noexcept
	{
		if (console != nullptr)
		{
			api->close_console(console);
		}
	}
};

void append_decimal(char16_t *&p, ::std::uint_least32_t value) noexcept
{
	char16_t digits[12];
	::std::size_t n{};
	do
	{
		digits[n++] = static_cast<char16_t>(u'0' + value % 10u);
		value /= 10u;
	} while (value != 0);
	while (n != 0)
	{
		*p++ = digits[--n];
	}
}

void make_pipe_name(char16_t *out, ::std::uint_least32_t tag) noexcept
{
	char16_t const prefix[]{u"\\\\.\\pipe\\pwa-code-"};
	auto *p{out};
	for (::std::size_t i{}; i + 1 < sizeof(prefix) / sizeof(prefix[0]); ++i)
	{
		*p++ = prefix[i];
	}
	append_decimal(p, win32::GetCurrentProcessId());
	*p++ = u'-';
	append_decimal(p, tag);
	*p = u'\0';
}

// One end of a byte-mode named pipe.  The end we keep carries
// FILE_FLAG_OVERLAPPED so the IOCP scheduler never blocks on it; the end handed
// to conhost is a separate file object and stays synchronous, which is what the
// console host expects.
void *open_pipe_end(char16_t const *name, ::std::uint_least32_t server_access) throws
{
	void *const server{win32::CreateNamedPipeW(name, server_access | file_flag_overlapped,
											   0 /* PIPE_TYPE_BYTE */, 1, 1u << 16, 1u << 16, 0,
											   nullptr)};
	if (server == invalid_handle_value())
	{
		::fast_io::throw_win32_error();
	}
	return server;
}

void *open_pipe_client(char16_t const *name, ::std::uint_least32_t access) throws
{
	void *const client{win32::CreateFileW(name, access, 0, nullptr, 3 /* OPEN_EXISTING */, 0, nullptr)};
	if (client == invalid_handle_value())
	{
		::fast_io::throw_win32_error();
	}
	return client;
}

void spawn_pty(terminal_process &proc) throws
{
	conpty_api const api{load_conpty_api()};

	// A per-process counter keeps repeated terminals from reusing a pipe name.
	static ::std::uint_least32_t pipe_serial{};
	++pipe_serial;
	char16_t input_name[64];
	char16_t output_name[64];
	make_pipe_name(input_name, pipe_serial * 2u);
	make_pipe_name(output_name, pipe_serial * 2u + 1u);

	handle_guard input_server{open_pipe_end(input_name, pipe_access_outbound)};
	handle_guard input_client{open_pipe_client(input_name, generic_read)};
	handle_guard output_server{open_pipe_end(output_name, pipe_access_inbound)};
	handle_guard output_client{open_pipe_client(output_name, generic_write)};

	char16_t command_line[1024]{};
	{
		::std::uint_least32_t const n{win32::GetEnvironmentVariableW(u"COMSPEC", command_line, 1023)};
		if (n == 0 || n >= 1023)
		{
			char16_t const fallback[]{u"cmd.exe"};
			for (::std::size_t i{}; i != sizeof(fallback) / sizeof(fallback[0]); ++i)
			{
				command_line[i] = fallback[i];
			}
		}
	}

	::std::size_t attributes_size{};
	(void)api.init_attributes(nullptr, 1, 0, &attributes_size);
	if (attributes_size == 0) [[unlikely]]
	{
		throw throws ::std::errc::not_enough_memory;
	}
	attribute_guard attributes{::malloc(attributes_size), __builtin_addressof(api)};
	if (attributes.list == nullptr) [[unlikely]]
	{
		throw throws ::std::errc::not_enough_memory;
	}
	if (!api.init_attributes(attributes.list, 1, 0, &attributes_size)) [[unlikely]]
	{
		::free(attributes.list);
		attributes.list = nullptr;  // a failed init must not be deleted
		::fast_io::throw_win32_error();
	}

	void *console{};
	win32_coord const size{120, 30};
	if (api.create(size, input_client.handle, output_client.handle, 0,
				   __builtin_addressof(console)) < 0) [[unlikely]]
	{
		if (console != nullptr)
		{
			api.close_console(console);
		}
		throw throws ::std::errc::not_enough_memory;
	}
	console_guard console_lifetime{console, __builtin_addressof(api)};
	if (!api.update_attribute(attributes.list, 0, proc_thread_attribute_pseudoconsole, console,
							  sizeof(console), nullptr, nullptr)) [[unlikely]]
	{
		::fast_io::throw_win32_error();
	}

	startupinfoex_w startup{};
	startup.startup.cb = sizeof(startupinfoex_w);
	startup.attributes = attributes.list;
	win32::process_information info{};
	bool const created{win32::CreateProcessW(
						   nullptr, command_line, nullptr, nullptr, 0, extended_startupinfo_present,
						   nullptr, nullptr,
						   reinterpret_cast<win32::startupinfow *>(__builtin_addressof(startup)),
						   __builtin_addressof(info)) != 0};
	if (!created) [[unlikely]]
	{
		::fast_io::throw_win32_error();
	}
	fi::io::perr("child pid=", info.dwProcessId, " cmd=",
				 ::fast_io::mnp::os_c_str(reinterpret_cast<char const *>(command_line)),
				 " exited=", win32::WaitForSingleObject(info.hProcess, 0) == 0, "\n");
	win32::CloseHandle(info.hThread);
	proc.process = info.hProcess;
	proc.console = console_lifetime.console;
	proc.input = input_server.release();
	proc.output = output_server.release();
	console_lifetime.console = nullptr;
}

void close_pty(terminal_process &proc) noexcept
{
	if (proc.process != nullptr)
	{
		win32::TerminateProcess(proc.process, 1);
		win32::CloseHandle(proc.process);
		proc.process = nullptr;
	}
	if (proc.console != nullptr)
	{
		void *const module{win32::GetModuleHandleW(u"kernel32.dll")};
		if (module != nullptr)
		{
			auto const close_console{reinterpret_cast<void(__stdcall *)(void *)>(
				win32::GetProcAddress(module, "ClosePseudoConsole"))};
			if (close_console != nullptr)
			{
				close_console(proc.console);
			}
		}
		proc.console = nullptr;
	}
	if (proc.input != nullptr)
	{
		win32::CloseHandle(proc.input);
		proc.input = nullptr;
	}
	if (proc.output != nullptr)
	{
		win32::CloseHandle(proc.output);
		proc.output = nullptr;
	}
}

// The ConPTY starts at a fixed size; the browser reports the real one as soon
// as the WebSocket opens and again whenever the panel changes size.
void resize_pty(terminal_process &proc, ::std::uint_least16_t cols,
				::std::uint_least16_t rows) noexcept
{
	if (proc.console == nullptr || cols == 0 || rows == 0)
	{
		return;
	}
	try
	{
		conpty_api const api{load_conpty_api()};
		if (api.resize != nullptr)
		{
			(void)api.resize(proc.console,
							 win32_coord{static_cast<::std::int_least16_t>(cols),
										 static_cast<::std::int_least16_t>(rows)});
		}
	}
	catch throws(::std::error e)
	{
	}
}

#else

void spawn_pty(fi::u8string_view shell, terminal_process &proc) throws
{
	int master{::posix_openpt(O_RDWR | O_NOCTTY | (pty_nonblocking ? O_NONBLOCK : 0))};
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
		// The shell must start with a clean descriptor table.  Anything the
		// server holds — the listener, other clients' sockets, open files —
		// would otherwise survive exec and keep a closed browser connection
		// in CLOSE_WAIT forever, so the browser waits for a close handshake
		// that never arrives and eventually exhausts its per-host sockets.
		bool closed{false};
#if defined(__linux__) && defined(SYS_close_range)
		// close_range is one syscall but needs Linux 5.9; older Android
		// kernels answer ENOSYS, so fall back to the descriptor loop.
		closed = ::syscall(SYS_close_range, 3u, ~0u, 0u) == 0;
#endif
		if (!closed)
		{
			long const open_max{::sysconf(_SC_OPEN_MAX)};
			int const fd_limit{open_max > 0 && open_max < 65536 ? static_cast<int>(open_max)
															   : 65536};
			for (int fd = 3; fd < fd_limit; ++fd)
			{
				::close(fd);
			}
		}
		char *argv[]{const_cast<char *>(reinterpret_cast<char const *>(shell.data())), nullptr};
		::execvp(argv[0], argv);
		::_exit(127);
	}
	proc.child = pid;
	proc.master.reset(master);
	// A sane default until the browser reports its real grid size.
	struct winsize initial{};
	initial.ws_col = 80;
	initial.ws_row = 24;
	(void)::ioctl(master, TIOCSWINSZ, __builtin_addressof(initial));
}

void resize_pty(terminal_process &proc, ::std::uint_least16_t cols,
				::std::uint_least16_t rows) noexcept
{
	if (proc.master.fd < 0 || cols == 0 || rows == 0)
	{
		return;
	}
	struct winsize ws{};
	ws.ws_col = cols;
	ws.ws_row = rows;
	(void)::ioctl(proc.master.fd, TIOCSWINSZ, __builtin_addressof(ws));
}

void close_pty(terminal_process &proc) noexcept
{
	if (proc.child > 0)
	{
		::kill(proc.child, SIGKILL);
		int status{};
		(void)::waitpid(proc.child, &status, 0);
		proc.child = 0;
	}
}

#endif

// The slice reads below run with a short deadline so each direction gets a turn.
// The IOCP backend enforces a deadline by cancelling the pending operation, and
// a cancelled operation surfaces as ERROR_OPERATION_ABORTED, so both spellings
// mean the same thing here: nothing arrived during this slice.
bool slice_elapsed(::std::error const &e) noexcept
{
	if (e.equivalent(::std::errc::timed_out))
	{
		return true;
	}
#if defined(_WIN32)
	return e.equivalent(static_cast<::fast_io::freestanding::win32_errc>(995u));
#else
	return false;
#endif
}

/* ------------------------ persistent sessions ----------------------- */

// A browser PWA frequently loses its WebSocket when it is backgrounded.  The
// PTY must outlive that socket, so sessions are kept here and a reconnecting
// browser attaches to the same shell by id.  Output read while a client is
// attached is retained in a bounded scrollback; output produced while nobody
// is attached stays in the kernel PTY buffer and is drained on reattach (the
// shell pauses if that buffer fills, so nothing is silently lost).
struct terminal_session
{
	terminal_session() noexcept = default;
	fi::u8string id;
	terminal_process proc;
	fi::vector<::std::byte> scrollback;
	::std::size_t scrollback_base{};
	::std::size_t detach_pos{};
	bool attached{};
	bool dead{};
	bool persistent{};
	::std::int_least64_t detached_at{};
	::std::uint_least16_t cols{80};
	::std::uint_least16_t rows{24};
};

constexpr ::std::size_t terminal_scrollback_limit{512u << 10};
constexpr ::std::size_t terminal_scrollback_slack{64u << 10};
constexpr ::std::int_least64_t terminal_session_ttl{30 * 60};

fi::vector<terminal_session *> &terminal_sessions() noexcept
{
	static fi::vector<terminal_session *> sessions;
	return sessions;
}

// Read one key=value pair from a raw query string.  Session ids and the replay
// flag are plain ASCII, so percent decoding is deliberately not needed here.
fi::u8string_view query_value(fi::u8string_view query, fi::u8string_view key) noexcept
{
	::std::size_t i{};
	while (i < query.size())
	{
		auto end{i};
		while (end < query.size() && query[end] != u8'&')
		{
			++end;
		}
		auto const pair{fi::u8string_view{query.data() + i, end - i}};
		if (pair.size() > key.size() && pair[key.size()] == u8'=' &&
			fi::u8string_view{pair.data(), key.size()} == key)
		{
			return fi::u8string_view{pair.data() + key.size() + 1,
									 pair.size() - key.size() - 1};
		}
		i = end + 1;
	}
	return {};
}

bool valid_terminal_session_id(fi::u8string_view id) noexcept
{
	if (id.size() < 8 || id.size() > 64)
	{
		return false;
	}
	for (auto const c : id)
	{
		bool const ok{(c >= u8'a' && c <= u8'z') || (c >= u8'A' && c <= u8'Z') ||
					  (c >= u8'0' && c <= u8'9') || c == u8'-' || c == u8'_'};
		if (!ok)
		{
			return false;
		}
	}
	return true;
}

terminal_session *find_terminal_session(fi::u8string_view id) noexcept
{
	for (auto *session : terminal_sessions())
	{
		if (fi::u8string_view{session->id.data(), session->id.size()} == id)
		{
			return session;
		}
	}
	return nullptr;
}

void unregister_terminal_session(terminal_session *session) throws
{
	auto &sessions{terminal_sessions()};
	for (::std::size_t i{}; i != sessions.size(); ++i)
	{
		if (sessions[i] == session)
		{
			sessions.erase(sessions.begin() + i);
			return;
		}
	}
}

void destroy_terminal_session(terminal_session *session) noexcept
{
	close_pty(session->proc);
	delete session;
}

// Detached sessions are dropped lazily when the next terminal connects.  This
// avoids a background timer while still bounding the number of orphaned shells.
void purge_terminal_sessions() throws
{
	auto &sessions{terminal_sessions()};
	auto const now{static_cast<::std::int_least64_t>(::fast_io::posix_clock_gettime(::fast_io::posix_clock_id::realtime).tv_sec)};
	::std::size_t i{};
	while (i < sessions.size())
	{
		auto *session{sessions[i]};
		bool const stale{!session->attached &&
						 (session->dead ||
						  (session->detached_at != 0 &&
						   now - session->detached_at > terminal_session_ttl))};
		if (stale)
		{
			sessions.erase(sessions.begin() + i);
			destroy_terminal_session(session);
		}
		else
		{
			++i;
		}
	}
}

void terminal_scrollback_append(terminal_session *session, ::std::byte const *data,
								::std::size_t len) throws
{
	for (::std::size_t i{}; i != len; ++i)
	{
		session->scrollback.push_back(data[i]);
	}
	if (session->scrollback.size() > terminal_scrollback_limit + terminal_scrollback_slack)
	{
		auto const drop{session->scrollback.size() - terminal_scrollback_limit};
		session->scrollback.erase(session->scrollback.begin(),
								  session->scrollback.begin() + drop);
		session->scrollback_base += drop;
	}
}

terminal_session *create_terminal_session(fi::u8string_view id, bool persistent,
										  fi::u8string_view shell) throws
{
	auto *session{new terminal_session{}};
	try
	{
		if (!id.is_empty())
		{
			session->id.assign(fi::u8string_view{id.data(), id.size()});
		}
		session->persistent = persistent;
#if defined(_WIN32)
		(void)shell;
		spawn_pty(session->proc);
#else
		spawn_pty(shell, session->proc);
#endif
	}
	catch throws(::std::error e)
	{
		delete session;
		throw throws e;
	}
	if (persistent)
	{
		terminal_sessions().push_back(session);
	}
	return session;
}

template <typename Sched>
fi::io_async_task<> send_session_scrollback(Sched sched, auto sock_io,
										   terminal_session *session,
										   bool replay) throws
{
	auto const end{session->scrollback_base + session->scrollback.size()};
	auto pos{replay ? session->scrollback_base : session->detach_pos};
	if (pos < session->scrollback_base)
	{
		pos = session->scrollback_base;
	}
	while (pos < end)
	{
		auto const want{end - pos < 16384 ? end - pos : ::std::size_t{16384}};
		co_await ws_send_frame(sched, sock_io, true, fi::websocket_opcode::binary,
							   session->scrollback.data() + (pos - session->scrollback_base),
							   want);
		pos += want;
	}
}

template <typename Sched>
fi::io_async_task<> ws_terminal(Sched sched, fi::u8iobuf_socket_file &sock,
								request const &req, fi::u8string_view query) throws
{
	purge_terminal_sessions();
	auto const requested_id{query_value(query, u8"session")};
	bool const persistent{valid_terminal_session_id(requested_id)};
	bool const replay{query_value(query, u8"replay") == fi::u8string_view{u8"1"}};
	terminal_session *session{persistent ? find_terminal_session(requested_id) : nullptr};
	if (session != nullptr && session->attached)
	{
		// The old socket has not noticed the close yet.  Reject this attempt;
		// the browser retries shortly, when the session is free again.
		co_await send_simple(sched, sock, 409, u8"Conflict",
							 u8"terminal session already attached", req, true);
		co_return;
	}
	if (session == nullptr)
	{
		fi::u8string shell;
#if !defined(_WIN32)
		auto const *shell_env{::getenv("SHELL")};
		if (shell_env != nullptr)
		{
			shell.assign(fi::u8string_view{reinterpret_cast<char8_t const *>(shell_env),
										   ::std::strlen(shell_env)});
		}
		else
		{
			shell.assign(u8"/bin/sh");
		}
#endif
		session = create_terminal_session(requested_id, persistent,
										  fi::u8string_view{shell.data(), shell.size()});
	}

	session->attached = true;
	session->detached_at = 0;
	bool const registered{session->persistent};
#if defined(_WIN32)
	fi::u8win32_io_observer const pty_in{session->proc.input};
	fi::u8win32_io_observer const pty_out{session->proc.output};
	fi::basic_win32_family_socket_io_observer<fi::win32_family::native, char8_t> const sock_io{
		sock.handle.hsocket};
#else
	fi::u8posix_io_observer const pty_in{session->proc.master.fd};
	fi::u8posix_io_observer const pty_out{session->proc.master.fd};
	fi::u8posix_socket_io_observer const sock_io{sock.handle.fd};
#endif

	try
	{
		char8_t accept[fi::websocket_accept_key_size];
		fi::websocket_accept_key(accept, req.ws_key.data(), req.ws_key.size());
		co_await fi::io::async_print(
			sched, {}, sock,
			u8"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
			u8"Sec-WebSocket-Accept: ",
			fi::u8string_view{accept, fi::websocket_accept_key_size}, u8"\r\n\r\n");
		co_await fop::async_output_stream_flush(sched, {}, sock);

		co_await send_session_scrollback(sched, sock_io, session, replay);

		bool running{true};
		ws_parser parser{};
		::std::byte rbuf[16384];
		while (running)
		{
#if defined(_WIN32)
			for (;;)
			{
				::std::uint_least32_t available{};
				if (!::PeekNamedPipe(session->proc.output, nullptr, 0, nullptr,
									 __builtin_addressof(available), nullptr))
				{
					session->dead = true;
					running = false;
					break;
				}
				if (available == 0)
				{
					break;
				}
				auto const want{static_cast<::std::size_t>(available) < sizeof(rbuf)
									? static_cast<::std::size_t>(available)
									: sizeof(rbuf)};
				auto const n{co_await fop::async_pread_some_bytes(sched, {}, pty_out, rbuf,
																 want, {})};
				if (n == 0)
				{
					session->dead = true;
					running = false;
					break;
				}
				terminal_scrollback_append(session, rbuf, n);
				co_await ws_send_frame(sched, sock_io, true, fi::websocket_opcode::binary,
									   rbuf, n);
			}
#else
			try
			{
				auto const n{co_await fop::async_pread_some_bytes(
					sched, timeout_milliseconds(8), pty_out, rbuf, sizeof(rbuf), {})};
				if (n == 0)
				{
					session->dead = true;
					running = false;
				}
				else
				{
					terminal_scrollback_append(session, rbuf, n);
					co_await ws_send_frame(sched, sock_io, true,
										   fi::websocket_opcode::binary, rbuf, n);
				}
			}
			catch throws(::std::error e)
			{
				if (!slice_elapsed(e))
				{
					session->dead = true;
					running = false;
				}
			}
#endif
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
				if (!slice_elapsed(e))
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
				case fi::websocket_opcode::binary:
					if (frame.payload.size() == 5 && frame.payload[0] == ::std::byte{1})
					{
						auto const cols{static_cast<::std::uint_least16_t>(
							(static_cast<unsigned>(frame.payload[1]) << 8) |
							static_cast<unsigned>(frame.payload[2]))};
						auto const rows{static_cast<::std::uint_least16_t>(
							(static_cast<unsigned>(frame.payload[3]) << 8) |
							static_cast<unsigned>(frame.payload[4]))};
						session->cols = cols;
						session->rows = rows;
						resize_pty(session->proc, cols, rows);
						break;
					}
					if (frame.payload.size() == 1 && frame.payload[0] == ::std::byte{3})
					{
						// Explicit Close in the UI terminates the shell; a
						// mere socket loss leaves the session detached.
						session->dead = true;
						running = false;
						break;
					}
					[[fallthrough]];
				case fi::websocket_opcode::text:
				case fi::websocket_opcode::continuation:
					if (!frame.payload.is_empty())
					{
						try
						{
							co_await async_write_all(sched, pty_in, frame.payload.data(),
													 frame.payload.size());
						}
						catch throws(::std::error e)
						{
							session->dead = true;
							running = false;
						}
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
	}
	catch throws(::std::error e)
	{
		// A dead socket is not a dead shell: fall through to the detach path.
	}

	if (session->dead)
	{
		if (registered)
		{
			unregister_terminal_session(session);
		}
		destroy_terminal_session(session);
	}
	else if (session->persistent)
	{
		session->attached = false;
		session->detach_pos = session->scrollback_base + session->scrollback.size();
		session->detached_at = static_cast<::std::int_least64_t>(::fast_io::posix_clock_gettime(::fast_io::posix_clock_id::realtime).tv_sec);
	}
	else
	{
		destroy_terminal_session(session);
	}
}

/* ----------------------------- HTTP -------------------------------- */

template <typename Sched>
fi::io_async_task<> session(Sched sched, fi::u8iobuf_socket_file sock,
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
				co_await ws_terminal(sched, sock, req,
									 fi::u8string_view{parts.query.data(), parts.query.size()});
				co_return;
			}
			if (req.method == fi::u8string_view{u8"OPTIONS"})
			{
				co_await send_preflight(sched, sock, req);
				if (!req.keep_alive)
				{
					co_return;
				}
				continue;
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

template <typename Sched>
fi::io_async_task<> accept_loop(Sched sched, fi::u8native_socket_io_observer listener,
								server_cfg cfg) throws
{
	for (;;)
	{
		fi::u8native_socket_file accepted{
			co_await fop::async_accept(sched, {}, listener, fi::open_mode::no_block)};
		session(sched, fi::u8iobuf_socket_file{::std::move(accepted)}, cfg).detach();
	}
}

// Drive the accept loop on one scheduler until it dies.  The body is a
// template so the same server can run on io_uring, the POSIX thread pool or
// Windows IOCP; only the scheduler type differs.
template <typename Sched>
[[noreturn]] inline void run_server(Sched scheduler, fi::u8native_socket_io_observer listener,
									server_cfg cfg) throws
{
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
		else if (arg == fi::u8cstring_view{u8"--no-uring"})
		{
			cfg.no_uring = true;
		}
		else if (arg == fi::u8cstring_view{u8"-h"} || arg == fi::u8cstring_view{u8"--help"})
		{
			fi::io::perr("Usage: pwacode-server [docs-root] [-p port] [-w workspace] "
						 "[--lna loopback|local|public] [--no-uring]\n");
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
	if (auto const *env{::getenv("PWA_NO_IO_URING")}; env != nullptr && env[0] != '\0' &&
														  !(env[0] == '0' && env[1] == '\0'))
	{
		cfg.no_uring = true;
	}

	fi::net_service service;
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
#if defined(_WIN32)
	fi::io_async_scheduler scheduler{fi::io_async};
	run_server<fi::io_async_observer>(scheduler, listener, cfg);
#else
	// Android kernels (and many sandboxes) refuse io_uring with EPERM, and an
	// app that somehow created a ring can still hang on enter.  Prefer the
	// portable thread-pool backend there and whenever the user asks for it;
	// otherwise try io_uring first and fall back if setup refuses.
	bool use_pool{cfg.no_uring};
#if defined(__ANDROID__)
	use_pool = true;
#endif
#if defined(__linux__)
	if (!use_pool)
	{
		try
		{
			// io_async defaults to an SQPOLL ring.  Its kernel thread
			// busy-spins while the terminal loop resubmits reads, so an idle
			// server can burn a whole core.  A plain ring sleeps in
			// io_uring_enter and keeps idle CPU at zero.
			fi::linux_io_uring scheduler{fi::native_interface, 64, 0};
			run_server<fi::linux_io_uring_observer>(scheduler, listener, cfg);
		}
		catch throws(::std::error e)
		{
			fi::io::perr("io_uring unavailable (", e,
						 "); falling back to the thread-pool backend\n");
		}
	}
#endif
	// The pool can only honour the PTY read deadline on a non-blocking
	// descriptor, so tell spawn_pty before the first session is created.
	pty_nonblocking = true;
	fi::posix_thread_pool scheduler{fi::io_async};
	run_server<fi::posix_thread_pool_observer>(scheduler, listener, cfg);
#endif
	}
	catch throws(::std::error e)
	{
		fi::io::perrln(e);
		return 1;
	}
}
