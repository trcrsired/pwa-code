// pwa-code portable document engine.
//
// The document is canonical UTF-8 with LF line endings.  Everything the web
// UI and the native player need is here: line indexing, refterm-style partial
// view rendering, bracket matching, indentation and save-time re-encoding.
#pragma once

#include <fast_io.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/string_view.h>
#include <fast_io_dsal/vector.h>

#include <cstddef>
#include <cstdint>

#include "encoding.h"
#include "syntax.h"

namespace pwa
{

enum class indent_mode : ::std::uint_least8_t
{
	two_spaces = 0,
	tab = 1
};

enum class eol_mode : ::std::uint_least8_t
{
	preserve = 0,
	lf = 1,
	crlf = 2
};

class document
{
public:
	void reset() throws
	{
		text_.clear();
		line_starts_.clear();
		line_starts_.push_back(0);
		path_.clear();
		display_name_.clear();
		encoding_ = text_encoding::utf8;
		has_bom_ = false;
		source_crlf_ = false;
		eol_ = eol_mode::preserve;
		lang_ = nullptr;
		state_cache_.clear();
		depth_cache_.clear();
		cache_valid_ = false;
		hex_data_.clear();
		hex_loaded_ = false;
	}

	// Load decoded UTF-8 text.  `normalize_crlf` also removes a UTF-8 BOM if
	// the caller forgot to strip it.
	void set_text(::fast_io::u8string_view text, bool normalize_crlf) throws
	{
		text_.clear();
		text_.reserve(text.size());
		if (!normalize_crlf || !contains_cr(text.data(), text.size()))
		{
			if (text.size() != 0)
			{
				text_.append(text.data(), text.size());
			}
			rebuild_index();
			return;
		}
		for (::std::size_t i{}; i != text.size(); ++i)
		{
			char8_t const c{text[i]};
			if (c == u8'\r')
			{
				if (i + 1 < text.size() && text[i + 1] == u8'\n')
				{
					continue;
				}
				text_.push_back(u8'\n');
			}
			else
			{
				text_.push_back(c);
			}
		}
		rebuild_index();
	}

	// Take ownership of already-decoded UTF-8 text.  This avoids a second
	// full-document copy on the wasm load path, which matters for very large
	// files; CRLF normalisation is done in place.
	void set_text_owned(::fast_io::u8string &&text, bool normalize_crlf) throws
	{
		text_ = ::std::move(text);
		if (normalize_crlf && contains_cr(text_.data(), text_.size()))
		{
			::std::size_t write{};
			for (::std::size_t read{}; read != text_.size(); ++read)
			{
				char8_t const c{text_[read]};
				if (c == u8'\r')
				{
					if (read + 1 < text_.size() && text_[read + 1] == u8'\n')
					{
						continue;
					}
					text_[write++] = u8'\n';
				}
				else
				{
					text_[write++] = c;
				}
			}
			if (write != text_.size())
			{
				text_.resize(write);
			}
		}
		rebuild_index();
	}

	void set_path(::fast_io::u8string_view path) throws
	{
		path_.clear();
		path_.append(path.data(), path.size());
		display_name_.clear();
		::std::size_t slash{};
		for (::std::size_t i{}; i != path.size(); ++i)
		{
			if (path[i] == u8'/' || path[i] == u8'\\')
			{
				slash = i + 1;
			}
		}
		display_name_.append(path.data() + slash, path.size() - slash);
		lang_ = syntax::language_for_path(path);
		cache_valid_ = false;
	}

	void set_encoding(text_encoding e, bool bom) noexcept
	{
		encoding_ = e;
		has_bom_ = bom;
	}

	void set_source_crlf(bool v) noexcept { source_crlf_ = v; }
	void set_eol_mode(eol_mode e) noexcept { eol_ = e; }

	[[nodiscard]] text_encoding encoding() const noexcept { return encoding_; }
	[[nodiscard]] bool has_bom() const noexcept { return has_bom_; }
	[[nodiscard]] bool source_crlf() const noexcept { return source_crlf_; }
	[[nodiscard]] eol_mode eol() const noexcept { return eol_; }
	[[nodiscard]] ::fast_io::u8string_view text() const noexcept
	{
		return ::fast_io::u8string_view{text_.data(), text_.size()};
	}
	[[nodiscard]] ::fast_io::u8string_view path() const noexcept
	{
		return ::fast_io::u8string_view{path_.data(), path_.size()};
	}
	[[nodiscard]] ::fast_io::u8string_view display_name() const noexcept
	{
		return ::fast_io::u8string_view{display_name_.data(), display_name_.size()};
	}
	[[nodiscard]] keywords::language const *language() const noexcept { return lang_; }
	[[nodiscard]] ::std::size_t size() const noexcept { return text_.size(); }
	[[nodiscard]] ::std::size_t line_count() const noexcept
	{
		return line_starts_.is_empty() ? 1 : line_starts_.size();
	}

	[[nodiscard]] ::fast_io::u8string_view line(::std::size_t index) const noexcept
	{
		if (line_starts_.is_empty() || index >= line_starts_.size())
		{
			return {};
		}
		auto const begin{line_starts_[index]};
		auto end{index + 1 < line_starts_.size() ? line_starts_[index + 1] : text_.size()};
		if (end > begin && end <= text_.size() && text_[end - 1] == u8'\n')
		{
			--end;
		}
		return ::fast_io::u8string_view{text_.data() + begin, end - begin};
	}

	[[nodiscard]] ::std::size_t line_of_offset(::std::size_t offset) const noexcept
	{
		if (line_starts_.is_empty())
		{
			return 0;
		}
		if (offset > text_.size())
		{
			offset = text_.size();
		}
		::std::size_t lo{};
		::std::size_t hi{line_starts_.size()};
		while (lo + 1 < hi)
		{
			auto const mid{(lo + hi) / 2};
			if (line_starts_[mid] <= offset)
			{
				lo = mid;
			}
			else
			{
				hi = mid;
			}
		}
		return lo;
	}

	[[nodiscard]] ::std::size_t line_start(::std::size_t index) const noexcept
	{
		return (index < line_starts_.size()) ? line_starts_[index] : text_.size();
	}

	// Replace a byte range.  Offsets are UTF-8 byte offsets in canonical text.
	void replace(::std::size_t begin, ::std::size_t end, ::fast_io::u8string_view insert) throws
	{
		if (begin > text_.size())
		{
			begin = text_.size();
		}
		if (end > text_.size())
		{
			end = text_.size();
		}
		if (end < begin)
		{
			auto const t{begin};
			begin = end;
			end = t;
		}
		::fast_io::u8string rebuilt;
		rebuilt.reserve(text_.size() - (end - begin) + insert.size());
		if (begin != 0)
		{
			rebuilt.append(text_.data(), begin);
		}
		rebuilt.append(insert.data(), insert.size());
		if (end < text_.size())
		{
			rebuilt.append(text_.data() + end, text_.size() - end);
		}
		text_ = ::std::move(rebuilt);
		rebuild_index();
	}

	// Insert text at a cursor offset.  Newlines are normalised to LF.
	void insert(::std::size_t offset, ::fast_io::u8string_view text) throws
	{
		::fast_io::u8string normalized;
		normalized.reserve(text.size());
		for (::std::size_t i{}; i != text.size(); ++i)
		{
			if (text[i] == u8'\r')
			{
				if (i + 1 < text.size() && text[i + 1] == u8'\n')
				{
					continue;
				}
				normalized.push_back(u8'\n');
			}
			else
			{
				normalized.push_back(text[i]);
			}
		}
		replace(offset, offset, ::fast_io::u8string_view{normalized.data(), normalized.size()});
	}

	// Indent every line touched by [begin,end).  Two spaces is the industrial
	// default; tab mode is the only alternative by design.
	void indent_range(::std::size_t begin, ::std::size_t end, indent_mode mode, bool outdent) throws
	{
		if (begin > text_.size())
		{
			begin = text_.size();
		}
		if (end > text_.size())
		{
			end = text_.size();
		}
		if (end < begin)
		{
			auto const t{begin};
			begin = end;
			end = t;
		}
		auto const first_line{line_of_offset(begin)};
		auto const last_line{line_of_offset(end)};
		::fast_io::u8string rebuilt;
		rebuilt.reserve(text_.size() + (last_line - first_line + 1) * 2);
		::std::size_t cursor{};
		for (::std::size_t ln{}; ln != line_starts_.size(); ++ln)
		{
			auto const ls{line_starts_[ln]};
			auto const le{ln + 1 < line_starts_.size() ? line_starts_[ln + 1] : text_.size()};
			if (ln >= first_line && ln <= last_line)
			{
				// Copy everything before this line verbatim.
				if (ls > cursor)
				{
					rebuilt.append(text_.data() + cursor, ls - cursor);
				}
				if (outdent)
				{
					if (ls < le && text_[ls] == u8'\t')
					{
						cursor = ls + 1;
					}
					else if (ls + 1 < le && text_[ls] == u8' ' && text_[ls + 1] == u8' ')
					{
						cursor = ls + 2;
					}
					else
					{
						cursor = ls;
					}
				}
				else
				{
					cursor = ls;
					if (mode == indent_mode::tab)
					{
						rebuilt.push_back(u8'\t');
					}
					else
					{
						rebuilt.push_back(u8' ');
						rebuilt.push_back(u8' ');
					}
				}
			}
		}
		if (cursor < text_.size())
		{
			rebuilt.append(text_.data() + cursor, text_.size() - cursor);
		}
		text_ = ::std::move(rebuilt);
		rebuild_index();
	}

	// Find the matching bracket for the bracket at `offset`.  Returns the
	// matching offset, or SIZE_MAX when there is no bracket/match.
	[[nodiscard]] ::std::size_t bracket_match(::std::size_t offset) const noexcept
	{
		if (offset >= text_.size())
		{
			return SIZE_MAX;
		}
		auto const c{text_[offset]};
		auto const opposite{[](char8_t ch) -> char8_t {
			switch (ch)
			{
			case u8'(': return u8')';
			case u8'[': return u8']';
			case u8'{': return u8'}';
			case u8')': return u8'(';
			case u8']': return u8'[';
			case u8'}': return u8'{';
			default: return 0;
			}
		}(c)};
		if (opposite == 0)
		{
			return SIZE_MAX;
		}
		bool const forward{c == u8'(' || c == u8'[' || c == u8'{'};
		int depth{};
		if (forward)
		{
			for (::std::size_t i{offset}; i != text_.size(); ++i)
			{
				if (text_[i] == c)
				{
					++depth;
				}
				else if (text_[i] == opposite)
				{
					if (--depth == 0)
					{
						return i;
					}
				}
			}
		}
		else
		{
			for (::std::size_t i{offset + 1}; i != 0;)
			{
				--i;
				if (text_[i] == c)
				{
					++depth;
				}
				else if (text_[i] == opposite)
				{
					if (--depth == 0)
					{
						return i;
					}
				}
			}
		}
		return SIZE_MAX;
	}

	// Convert a JavaScript UTF-16 code-unit offset into the byte offset used
	// by the UTF-8 document.  Surrogate pairs count as two UTF-16 units.
	[[nodiscard]] ::std::size_t utf16_to_utf8_offset(::std::size_t utf16_offset) const noexcept
	{
		::std::size_t units{};
		::std::size_t i{};
		while (i < text_.size() && units < utf16_offset)
		{
			auto const c{static_cast<unsigned char>(text_[i])};
			::std::size_t len{1};
			::std::uint_least32_t cp{c};
			if ((c & 0xE0u) == 0xC0u)
			{
				len = 2;
				cp = c & 0x1Fu;
			}
			else if ((c & 0xF0u) == 0xE0u)
			{
				len = 3;
				cp = c & 0x0Fu;
			}
			else if ((c & 0xF8u) == 0xF0u)
			{
				len = 4;
				cp = c & 0x07u;
			}
			if (i + len > text_.size())
			{
				len = text_.size() - i;
			}
			for (::std::size_t j{1}; j < len; ++j)
			{
				cp = (cp << 6) | (static_cast<unsigned char>(text_[i + j]) & 0x3Fu);
			}
			units += cp >= 0x10000u ? 2u : 1u;
			i += len;
		}
		return i;
	}

	// Bracket matching for a UTF-16 offset from the textarea.  Returns the
	// matching byte offset (for render_view), or SIZE_MAX when unmatched.
	[[nodiscard]] ::std::size_t bracket_match_utf16(::std::size_t utf16_offset) const noexcept
	{
		return bracket_match(utf16_to_utf8_offset(utf16_offset));
	}

	// ---- refterm-style partial view ------------------------------------

	void render_view(::std::size_t first_line, ::std::size_t count, bool show_line_numbers,
					 ::fast_io::u8string &out,
					 ::std::size_t match_offset = SIZE_MAX) const throws
	{
		using namespace ::fast_io::io;
		out.clear();
		if (line_starts_.size() == 0)
		{
			return;
		}
		if (first_line >= line_starts_.size())
		{
			return;
		}
		if (first_line + count > line_starts_.size())
		{
			count = line_starts_.size() - first_line;
		}
		ensure_cache_through(first_line + count);
		auto state{state_cache_[first_line]};
		int depth{depth_cache_[first_line]};
		::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(out)};
		for (::std::size_t i{}; i != count; ++i)
		{
			auto const ln{first_line + i};
			print(writer, u8"<div class=\"vl\" data-l=\"", ln, u8"\">");
			if (show_line_numbers)
			{
				print(writer, u8"<span class=\"ln\">", ln + 1, u8"</span>");
			}
			print(writer, u8"<span class=\"lc\">");
			syntax::render_line(line(ln), lang_, state, depth, writer, line_starts_[ln],
								match_offset);
			print(writer, u8"</span></div>");
		}
	}

	// ---- hex editor ----------------------------------------------------

	void load_hex(::std::byte const *data, ::std::size_t size) throws
	{
		hex_data_.clear();
		hex_data_.resize(size);
		if (size != 0)
		{
			__builtin_memcpy(hex_data_.data(), data, size);
		}
		hex_loaded_ = true;
	}

	[[nodiscard]] bool hex_loaded() const noexcept { return hex_loaded_; }
	[[nodiscard]] ::std::size_t hex_size() const noexcept { return hex_data_.size(); }
	[[nodiscard]] ::std::byte const *hex_data() const noexcept { return hex_data_.data(); }

	void hex_patch(::std::size_t offset, ::std::byte value) noexcept
	{
		if (offset < hex_data_.size())
		{
			hex_data_[offset] = value;
		}
	}

	void render_hex(::std::size_t offset, ::std::size_t rows, ::std::size_t columns,
					::fast_io::u8string &out) const throws
	{
		using namespace ::fast_io::io;
		out.clear();
		if (columns == 0)
		{
			columns = 16;
		}
		::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(out)};
		for (::std::size_t r{}; r != rows; ++r)
		{
			auto const base{offset + r * columns};
			if (base >= hex_data_.size())
			{
				break;
			}
			print(writer, u8"<div class=\"hr\" data-o=\"", base, u8"\"><span class=\"ha\">",
				  ::fast_io::mnp::baseupper<16, false, true>(
					  static_cast<::std::uint_least32_t>(base)),
				  u8"</span> ");
			for (::std::size_t c{}; c != columns; ++c)
			{
				auto const i{base + c};
				if (i < hex_data_.size())
				{
					print(writer, u8"<span class=\"hb\" data-o=\"", i, u8"\">",
						  ::fast_io::mnp::hexupper<false, true>(
							  static_cast<::std::uint_least8_t>(hex_data_[i])),
						  u8"</span>");
				}
				else
				{
					print(writer, u8"<span class=\"hb empty\">  </span>");
				}
				if (c + 1 != columns)
				{
					print(writer, u8" ");
				}
			}
			print(writer, u8"  <span class=\"hc\">");
			for (::std::size_t c{}; c != columns; ++c)
			{
				auto const i{base + c};
				if (i >= hex_data_.size())
				{
					break;
				}
				auto const v{static_cast<::std::uint_least8_t>(hex_data_[i])};
				if (v >= 32 && v < 127)
				{
					syntax::print_escaped_char(writer, static_cast<char8_t>(v));
				}
				else
				{
					print(writer, u8".");
				}
			}
			print(writer, u8"</span></div>");
		}
	}

	// ---- save ----------------------------------------------------------

	// Encodes the canonical text with the document's encoding/BOM and EOL
	// policy.  `LF by default` is enforced here: CRLF is only emitted when the
	// source file used it (preserve) or the user explicitly selected it.
	void save_bytes(::fast_io::vector<::std::byte> &out) const throws
	{
		bool crlf = eol_ == eol_mode::crlf || (eol_ == eol_mode::preserve && source_crlf_);
		::fast_io::u8string encoded;
		encoded.reserve(text_.size() + 16);
		if (crlf)
		{
			for (::std::size_t i{}; i != text_.size(); ++i)
			{
				if (text_[i] == u8'\n' && (i == 0 || text_[i - 1] != u8'\r'))
				{
					encoded.push_back(u8'\r');
				}
				encoded.push_back(text_[i]);
			}
		}
		else
		{
			encoded.append(text_.data(), text_.size());
		}
		encode_from_utf8(::fast_io::u8string_view{encoded.data(), encoded.size()}, encoding_, has_bom_, out);
	}

private:
	// CRLF normalisation is a no-op for the overwhelmingly common LF file.
	// Scan a SIMD lane at a time so a large UTF-8 document does not pay a
	// scalar pass over every byte just to discover there is no CR.
	[[nodiscard]] static bool contains_cr(char8_t const *data, ::std::size_t size) noexcept
	{
		::std::size_t i{};
		if (size >= 16)
		{
			constexpr ::std::size_t lane{16};
			using vector_type = ::fast_io::intrinsics::simd_vector<char8_t, lane>;
			vector_type crs{};
			for (::std::size_t k{}; k != lane; ++k)
			{
				crs.value[k] = u8'\r';
			}
			for (; i + lane <= size; i += lane)
			{
				vector_type block;
				block.load(data + i);
				if (!::fast_io::intrinsics::is_all_zeros(block == crs))
				{
					return true;
				}
			}
		}
		for (; i != size; ++i)
		{
			if (data[i] == u8'\r')
			{
				return true;
			}
		}
		return false;
	}

	void rebuild_index() throws
	{
		line_starts_.clear();
		line_starts_.push_back(0);
		auto const size{text_.size()};
		auto const *data{text_.data()};
		::std::size_t i{};
		// The newline scan is the hot path when opening a large file (and on
		// every edit, because the index is rebuilt).  Compare a whole SIMD
		// lane at a time and only walk the bytes of lanes that contain a
		// newline.  The same code falls back to fast_io's scalar simd_vector
		// implementation on targets without SIMD.
		if (size >= 16)
		{
			constexpr ::std::size_t lane{16};
			using vector_type = ::fast_io::intrinsics::simd_vector<char8_t, lane>;
			vector_type newlines{};
			for (::std::size_t k{}; k != lane; ++k)
			{
				newlines.value[k] = u8'\n';
			}
			for (; i + lane <= size; i += lane)
			{
				vector_type block;
				block.load(data + i);
				auto const mask{block == newlines};
				if (::fast_io::intrinsics::is_all_zeros(mask))
				{
					continue;
				}
				for (::std::size_t k{}; k != lane; ++k)
				{
					if (mask.value[k] != 0)
					{
						line_starts_.push_back(i + k + 1);
					}
				}
			}
		}
		for (; i != size; ++i)
		{
			if (data[i] == u8'\n')
			{
				line_starts_.push_back(i + 1);
			}
		}
		cache_valid_ = false;
	}

	// Only the visible prefix needs a syntax state.  Building the table lazily
	// keeps the first paint of a huge file cheap and bounds memory to the lines
	// that have actually been looked at.
	void ensure_cache_through(::std::size_t count) const throws
	{
		if (line_starts_.is_empty())
		{
			return;
		}
		if (count > line_starts_.size())
		{
			count = line_starts_.size();
		}
		if (!cache_valid_)
		{
			state_cache_.clear();
			depth_cache_.clear();
			cache_valid_ = true;
		}
		auto const have{state_cache_.size()};
		if (have >= count)
		{
			return;
		}
		if (lang_ == nullptr)
		{
			// Plain text has no multi-line state; value-initialisation is enough
			// and avoids walking millions of lines just to store zeroes.
			state_cache_.resize(count);
			depth_cache_.resize(count);
			return;
		}
		state_cache_.resize(count);
		depth_cache_.resize(count);
		syntax::render_state state{};
		int depth{};
		if (have != 0)
		{
			state = state_cache_[have - 1];
			depth = depth_cache_[have - 1];
		}
		for (::std::size_t i{have}; i != count; ++i)
		{
			state_cache_[i] = state;
			depth_cache_[i] = depth;
			syntax::scan_line_full(line(i), lang_, state, depth);
		}
	}

	::fast_io::u8string text_;
	::fast_io::vector<::std::size_t> line_starts_;
	::fast_io::u8string path_;
	::fast_io::u8string display_name_;
	text_encoding encoding_{text_encoding::utf8};
	bool has_bom_{};
	bool source_crlf_{};
	eol_mode eol_{eol_mode::preserve};
	keywords::language const *lang_{};
	mutable ::fast_io::vector<syntax::render_state> state_cache_;
	mutable ::fast_io::vector<int> depth_cache_;
	mutable bool cache_valid_{false};
	::fast_io::vector<::std::byte> hex_data_;
	bool hex_loaded_{};
};

} // namespace pwa
