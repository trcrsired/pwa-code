// pwa-code WebAssembly entry points.
//
// The module is deliberately a pure engine: it never touches browser storage.
// JavaScript writes bytes into the module with pwa_alloc(), calls an export,
// then reads a result from the shared output buffers.  The same document /
// encoding / highlighting code is compiled into the native player and server.
//
// Error handling inside the engine is herbception-only: every fallible core
// function is declared `throws`, and failures propagate as `::std::error`.
// A C ABI cannot carry a herbception across the JS boundary, so the exports
// are the one place where an error is marshalled: the handler records the
// domain/code/message and the export returns its documented sentinel.  Use
// pwa_error_* to read the failure; it is never a second error-reporting path
// inside the engine.
#include <fast_io.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/string_view.h>
#include <fast_io_dsal/vector.h>

#include <cstdlib>

#include "../core/document.h"
#include "../core/encoding.h"

namespace
{

pwa::document doc;
::fast_io::u8string out_text;
::fast_io::u8string view_html;
::fast_io::u8ostring_ref_fast_io out_writer{__builtin_addressof(out_text)};
::fast_io::u8ostring_ref_fast_io view_writer{__builtin_addressof(view_html)};

::fast_io::u8string error_text;
::std::size_t error_code{};
::std::uint_least32_t error_kind{};
bool error_pending{};

constexpr ::std::size_t max_view_lines{100000};

inline ::std::size_t pack_probe(pwa::encoding_probe const &p) noexcept
{
	return static_cast<::std::size_t>(p.encoding) | (p.has_bom ? 0x100u : 0u) |
		   (p.source_crlf ? 0x200u : 0u) | (p.bom_length << 10);
}

// The boundary marshaler.  It only reads the handler-owned ::std::error and
// formats it into a buffer; it never returns an error code to the engine.
void record_error(::std::error const &e) noexcept
{
	error_pending = true;
	error_code = e.code();
	error_kind = e.is_code_of<::std::errc>() ? 1u
				 : e.is_code_of<::std::parse_errc>() ? 2u
													 : 0u;
	error_text.clear();
	try
	{
		::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(error_text)};
		::fast_io::io::print(writer, ::fast_io::mnp::message(e));
	}
	catch throws(::std::error)
	{
		// Reporting must not replace the original failure.
		error_text.clear();
	}
}

void clear_error() noexcept
{
	error_pending = false;
	error_code = 0;
	error_kind = 0;
	error_text.clear();
}

template <typename F, typename R>
R abi_value(F &&f, R fallback) noexcept
{
	clear_error();
	try
	{
		return f();
	}
	catch throws(::std::error e)
	{
		record_error(e);
		return fallback;
	}
}

template <typename F>
void abi_void(F &&f) noexcept
{
	clear_error();
	try
	{
		f();
	}
	catch throws(::std::error e)
	{
		record_error(e);
	}
}

} // namespace

extern "C"
{

[[__gnu__::__visibility__("default")]] void *pwa_alloc(::std::size_t n) noexcept
{
	return ::std::malloc(n);
}

[[__gnu__::__visibility__("default")]] void pwa_free(void *p) noexcept
{
	::std::free(p);
}

[[__gnu__::__visibility__("default")]] char8_t const *pwa_out_ptr() noexcept
{
	return out_text.c_str();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_out_len() noexcept
{
	return out_text.size();
}

[[__gnu__::__visibility__("default")]] char8_t const *pwa_view_ptr() noexcept
{
	return view_html.c_str();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_view_len() noexcept
{
	return view_html.size();
}

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_version() noexcept
{
	return 2;
}

/* ---- boundary error channel ---------------------------------------- */

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_error_pending() noexcept
{
	return error_pending ? 1u : 0u;
}

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_error_kind() noexcept
{
	return error_kind;
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_error_code() noexcept
{
	return error_code;
}

[[__gnu__::__visibility__("default")]] char8_t const *pwa_error_ptr() noexcept
{
	return error_text.c_str();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_error_len() noexcept
{
	return error_text.size();
}

[[__gnu__::__visibility__("default")]] void pwa_error_clear() noexcept
{
	clear_error();
}

/* ---- encoding ------------------------------------------------------ */

// Returns: encoding id in bits 0-7, BOM flag bit 8, source-CRLF bit 9,
// BOM length in bits 10-19.
[[__gnu__::__visibility__("default")]] ::std::size_t pwa_probe(::std::uint8_t const *data,
												  ::std::size_t len) noexcept
{
	return pack_probe(pwa::probe_encoding(reinterpret_cast<::std::byte const *>(data), len));
}

// Decode arbitrary bytes to UTF-8 in the output buffer.  from = -1 means probe.
[[__gnu__::__visibility__("default")]] ::std::size_t pwa_transcode_to_utf8(
	::std::uint8_t const *data, ::std::size_t len, ::std::int_least32_t from) noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			auto probe{pwa::probe_encoding(reinterpret_cast<::std::byte const *>(data), len)};
			if (from >= 0)
			{
				if (from > 7)
				{
					throw throws ::std::errc::invalid_argument;
				}
				probe.encoding = static_cast<pwa::text_encoding>(from);
			}
			out_text.clear();
			pwa::decode_to_utf8(reinterpret_cast<::std::byte const *>(data), len, probe, out_text);
			return out_text.size();
		},
		::std::size_t{});
}

/* ---- document ------------------------------------------------------ */

// Load a file.  forced_encoding = -1 probes.  Returns the chosen encoding id,
// or 255 when the bytes cannot be decoded.
[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_doc_load(
	::std::uint8_t const *data, ::std::size_t len, char8_t const *path, ::std::size_t path_len,
	::std::int_least32_t forced_encoding) noexcept
{
	return abi_value(
		[&]() throws -> ::std::uint_least32_t {
			auto probe{pwa::probe_encoding(reinterpret_cast<::std::byte const *>(data), len)};
			if (forced_encoding >= 0)
			{
				if (forced_encoding > 7)
				{
					throw throws ::std::errc::invalid_argument;
				}
				probe.encoding = static_cast<pwa::text_encoding>(forced_encoding);
				// A forced non-UTF-8 encoding with no BOM must not eat the first bytes.
				if (!probe.has_bom && probe.bom_length != 0)
				{
					probe.bom_length = 0;
					probe.has_bom = false;
				}
			}
			::fast_io::u8string decoded;
			pwa::decode_to_utf8(reinterpret_cast<::std::byte const *>(data), len, probe, decoded);
			doc.reset();
			doc.set_text_owned(::std::move(decoded), true);
			doc.set_path(::fast_io::u8string_view{path, path_len});
			doc.set_encoding(probe.encoding, probe.has_bom);
			doc.set_source_crlf(probe.source_crlf);
			return static_cast<::std::uint_least32_t>(probe.encoding);
		},
		::std::uint_least32_t{255});
}

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_doc_encoding() noexcept
{
	return static_cast<::std::uint_least32_t>(doc.encoding());
}

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_doc_bom() noexcept
{
	return doc.has_bom() ? 1u : 0u;
}

[[__gnu__::__visibility__("default")]] ::std::uint_least32_t pwa_doc_source_crlf() noexcept
{
	return doc.source_crlf() ? 1u : 0u;
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_doc_line_count() noexcept
{
	return doc.line_count();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_doc_size() noexcept
{
	return doc.size();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_doc_get_text() noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			out_text.clear();
			auto const t{doc.text()};
			out_text.append(t.data(), t.size());
			return out_text.size();
		},
		::std::size_t{});
}

[[__gnu__::__visibility__("default")]] void pwa_doc_set_text(::std::uint8_t const *data,
											   ::std::size_t len) noexcept
{
	abi_void([&]() throws {
		doc.set_text(::fast_io::u8string_view{reinterpret_cast<char8_t const *>(data), len}, true);
	});
}

// Tabs keep one decoded buffer in the engine and restore the path (and with it
// the syntax language) when switching.  set_text deliberately leaves the path
// alone, so these setters round-trip a tab without re-encoding the file.
[[__gnu__::__visibility__("default")]] void pwa_doc_set_path(::std::uint8_t const *data,
											   ::std::size_t len) noexcept
{
	abi_void([&]() throws {
		doc.set_path(::fast_io::u8string_view{reinterpret_cast<char8_t const *>(data), len});
	});
}

[[__gnu__::__visibility__("default")]] void pwa_doc_set_source_crlf(
	::std::uint_least32_t value) noexcept
{
	clear_error();
	doc.set_source_crlf(value != 0);
}

[[__gnu__::__visibility__("default")]] void pwa_doc_insert(::std::size_t offset,
											 ::std::uint8_t const *data, ::std::size_t len) noexcept
{
	abi_void([&]() throws {
		doc.insert(offset, ::fast_io::u8string_view{reinterpret_cast<char8_t const *>(data), len});
	});
}

[[__gnu__::__visibility__("default")]] void pwa_doc_replace(::std::size_t begin, ::std::size_t end,
											  ::std::uint8_t const *data, ::std::size_t len) noexcept
{
	abi_void([&]() throws {
		doc.replace(begin, end,
					::fast_io::u8string_view{reinterpret_cast<char8_t const *>(data), len});
	});
}

[[__gnu__::__visibility__("default")]] void pwa_doc_set_encoding(::std::uint_least32_t enc,
												   ::std::uint_least32_t bom) noexcept
{
	clear_error();
	doc.set_encoding(static_cast<pwa::text_encoding>(enc), bom != 0);
}

[[__gnu__::__visibility__("default")]] void pwa_doc_set_eol(::std::uint_least32_t mode) noexcept
{
	clear_error();
	doc.set_eol_mode(static_cast<pwa::eol_mode>(mode));
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_doc_language() noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			auto const *lang{doc.language()};
			if (lang == nullptr)
			{
				out_text.clear();
				return 0;
			}
			out_text.assign(lang->name);
			return out_text.size();
		},
		::std::size_t{});
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_doc_save_text() noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			::fast_io::vector<::std::byte> bytes;
			doc.save_bytes(bytes);
			out_text.clear();
			out_text.resize(bytes.size());
			if (bytes.size() != 0)
			{
				__builtin_memcpy(out_text.data(), bytes.data(), bytes.size());
			}
			return out_text.size();
		},
		::std::size_t{});
}

/* ---- partial view + editing helpers -------------------------------- */

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_view(::std::size_t first,
														  ::std::size_t count,
														  ::std::uint_least32_t line_numbers,
														  ::std::size_t match_offset) noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			doc.render_view(first, count > max_view_lines ? max_view_lines : count,
							line_numbers != 0, view_html, match_offset);
			return view_html.size();
		},
		::std::size_t{});
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_bracket_match(::std::size_t offset) noexcept
{
	return doc.bracket_match(offset);
}

[[__gnu__::__visibility__("default")]] ::std::size_t
pwa_bracket_match_utf16(::std::size_t offset) noexcept
{
	return doc.bracket_match_utf16(offset);
}

[[__gnu__::__visibility__("default")]] void pwa_indent(::std::size_t begin, ::std::size_t end,
										   ::std::uint_least32_t mode,
										   ::std::uint_least32_t outdent) noexcept
{
	abi_void([&]() throws {
		doc.indent_range(begin, end, static_cast<pwa::indent_mode>(mode), outdent != 0);
	});
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_line_start(::std::size_t line) noexcept
{
	return doc.line_start(line);
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_line_of_offset(::std::size_t offset) noexcept
{
	return doc.line_of_offset(offset);
}

/* ---- hex editor ---------------------------------------------------- */

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_hex_size() noexcept
{
	return doc.hex_size();
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_hex_render(::std::size_t offset,
													   ::std::size_t rows,
													   ::std::size_t columns) noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			doc.render_hex(offset, rows, columns, view_html);
			return view_html.size();
		},
		::std::size_t{});
}

[[__gnu__::__visibility__("default")]] void pwa_hex_patch(::std::size_t offset,
											 ::std::uint_least32_t value) noexcept
{
	clear_error();
	doc.hex_patch(offset, static_cast<::std::byte>(value & 0xFFu));
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_hex_bytes() noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			out_text.clear();
			out_text.resize(doc.hex_size());
			if (doc.hex_size() != 0)
			{
				__builtin_memcpy(out_text.data(), doc.hex_data(), doc.hex_size());
			}
			return out_text.size();
		},
		::std::size_t{});
}

// Re-encode the current text into the hex buffer (switch from text to hex).
[[__gnu__::__visibility__("default")]] ::std::size_t pwa_hex_from_text() noexcept
{
	return abi_value(
		[&]() throws -> ::std::size_t {
			::fast_io::vector<::std::byte> bytes;
			doc.save_bytes(bytes);
			doc.load_hex(bytes.data(), bytes.size());
			out_text.clear();
			out_text.resize(bytes.size());
			if (bytes.size() != 0)
			{
				__builtin_memcpy(out_text.data(), bytes.data(), bytes.size());
			}
			return out_text.size();
		},
		::std::size_t{});
}

[[__gnu__::__visibility__("default")]] ::std::size_t pwa_hex_save() noexcept
{
	return pwa_hex_bytes();
}

} // extern "C"
