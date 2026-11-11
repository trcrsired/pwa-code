// pwa-code syntax highlighting.
//
// The word tables in keywords_data.inc come from Notepad++'s default keyword
// lists (see build/gen_keywords.py), so a file highlights the same way it
// would in Notepad++.
//
// Highlighting is line-oriented and keeps only one bit of cross-line state
// (inside a block comment), which is what a partial-view renderer needs: the
// caller can ask for any line range without tokenising the whole document, as
// long as it supplies the block-comment state at the first line.
#pragma once

#include <fast_io.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/string_view.h>

#include <cstddef>
#include <cstdint>

#include "keywords_data.inc"

namespace pwa::syntax
{

struct render_state
{
	bool in_block_comment{};
};

inline ::std::uint_least8_t ascii_lower(::std::uint_least8_t c) noexcept
{
	return (c >= u8'A' && c <= u8'Z') ? static_cast<::std::uint_least8_t>(c + 32) : c;
}

inline bool ascii_ieq(::fast_io::u8string_view a, ::fast_io::u8string_view b) noexcept
{
	if (a.size() != b.size())
	{
		return false;
	}
	for (::std::size_t i{}; i != a.size(); ++i)
	{
		if (ascii_lower(static_cast<::std::uint_least8_t>(a[i])) !=
			ascii_lower(static_cast<::std::uint_least8_t>(b[i])))
		{
			return false;
		}
	}
	return true;
}

inline ::fast_io::u8string_view extension_of(::fast_io::u8string_view path) noexcept
{
	::std::size_t dot{path.size()};
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
	if (dot == path.size())
	{
		return {};
	}
	return ::fast_io::u8string_view{path.data() + dot, path.size() - dot};
}

// Find the language whose extension list contains `ext`.
inline keywords::language const *language_for_extension(::fast_io::u8string_view ext) noexcept
{
	if (ext.is_empty())
	{
		return nullptr;
	}
	for (::std::size_t li{}; li != keywords::language_count; ++li)
	{
		auto const &lang{keywords::languages[li]};
		auto exts{lang.exts};
		::std::size_t i{};
		while (i < exts.size())
		{
			::std::size_t j{i};
			while (j < exts.size() && exts[j] != u8' ')
			{
				++j;
			}
			auto const candidate{::fast_io::u8string_view{exts.data() + i, j - i}};
			if (ascii_ieq(candidate, ext))
			{
				return __builtin_addressof(lang);
			}
			i = j + 1;
		}
	}
	return nullptr;
}

inline keywords::language const *language_for_path(::fast_io::u8string_view path) noexcept
{
	return language_for_extension(extension_of(path));
}

// Binary search the generated, byte-sorted word table.
inline ::std::uint_least8_t classify_word(::fast_io::u8string_view word,
										  keywords::language const *lang) noexcept
{
	if (lang == nullptr || word.is_empty())
	{
		return 0;
	}
	::std::size_t lo{};
	::std::size_t hi{lang->word_count};
	while (lo < hi)
	{
		auto const mid{(lo + hi) / 2};
		auto const &entry{lang->words[mid]};
		int cmp{};
		{
			auto const n{word.size() < entry.word.size() ? word.size() : entry.word.size()};
			for (::std::size_t i{}; i != n; ++i)
			{
				auto const a{static_cast<::std::uint_least8_t>(word[i])};
				auto const b{static_cast<::std::uint_least8_t>(entry.word[i])};
				if (a != b)
				{
					cmp = a < b ? -1 : 1;
					break;
				}
			}
			if (cmp == 0)
			{
				cmp = word.size() < entry.word.size() ? -1 : (word.size() > entry.word.size() ? 1 : 0);
			}
		}
		if (cmp == 0)
		{
			return entry.kind;
		}
		if (cmp < 0)
		{
			hi = mid;
		}
		else
		{
			lo = mid + 1;
		}
	}
	return 0;
}

inline void print_escaped_char(::fast_io::u8ostring_ref_fast_io out, char8_t ch) throws
{
	using namespace ::fast_io::io;
	switch (ch)
	{
	case u8'&': print(out, u8"&amp;"); break;
	case u8'<': print(out, u8"&lt;"); break;
	case u8'>': print(out, u8"&gt;"); break;
	case u8'"': print(out, u8"&quot;"); break;
	default: print(out, ::fast_io::mnp::chvw(ch));
	}
}

inline void print_escaped(::fast_io::u8ostring_ref_fast_io out, ::fast_io::u8string_view sv) throws
{
	using namespace ::fast_io::io;
	for (char8_t ch : sv)
	{
		print_escaped_char(out, ch);
	}
}

inline bool is_ident_start(char8_t c) noexcept
{
	auto const u{static_cast<::std::uint_least8_t>(c)};
	return (u >= u8'a' && u <= u8'z') || (u >= u8'A' && u <= u8'Z') || u == u8'_' || u == u8'$' ||
		   u >= 0x80;
}

inline bool is_ident_char(char8_t c) noexcept
{
	auto const u{static_cast<::std::uint_least8_t>(c)};
	return is_ident_start(c) || (u >= u8'0' && u <= u8'9');
}

inline bool is_digit(char8_t c) noexcept
{
	auto const u{static_cast<::std::uint_least8_t>(c)};
	return u >= u8'0' && u <= u8'9';
}

inline bool starts_at(::fast_io::u8string_view line, ::std::size_t pos, ::fast_io::u8string_view what) noexcept
{
	if (what.is_empty() || pos + what.size() > line.size())
	{
		return false;
	}
	for (::std::size_t i{}; i != what.size(); ++i)
	{
		if (line[pos + i] != what[i])
		{
			return false;
		}
	}
	return true;
}

// Append one coloured token.  `klass` is a short CSS suffix:
//   k keyword, t type, s string, c comment, n number, p preprocessor, bN bracket
inline void span_begin(::fast_io::u8ostring_ref_fast_io out, ::fast_io::u8string_view klass) throws
{
	using namespace ::fast_io::io;
	print(out, u8"<span class=\"t-", klass, u8"\">");
}

inline void span_end(::fast_io::u8ostring_ref_fast_io out) throws
{
	::fast_io::io::print(out, u8"</span>");
}

// Render one line.  `depth` carries the bracket nesting depth across lines;
// `state.in_block_comment` carries block-comment state.
inline void render_line(::fast_io::u8string_view line, keywords::language const *lang,
						render_state &state, int &depth, ::fast_io::u8ostring_ref_fast_io out,
						::std::size_t line_start = 0,
						::std::size_t match_offset = SIZE_MAX) throws
{
	using namespace ::fast_io::io;
	auto const line_comment{lang ? lang->line_comment : ::fast_io::u8string_view{}};
	auto const block_open{lang ? lang->block_open : ::fast_io::u8string_view{}};
	auto const block_close{lang ? lang->block_close : ::fast_io::u8string_view{}};

	::std::size_t i{};
	bool first_token{true};
	while (i < line.size())
	{
		// Block comment continuation.
		if (state.in_block_comment)
		{
			auto const begin{i};
			::std::size_t end{line.size()};
			bool closed{};
			if (!block_close.is_empty())
			{
				for (::std::size_t j{i}; j + block_close.size() <= line.size(); ++j)
				{
					if (starts_at(line, j, block_close))
					{
						end = j + block_close.size();
						closed = true;
						break;
					}
				}
			}
			span_begin(out, u8"c");
			print_escaped(out, ::fast_io::u8string_view{line.data() + begin, end - begin});
			span_end(out);
			i = end;
			if (closed)
			{
				state.in_block_comment = false;
			}
			else
			{
				// The comment runs to the end of the line; nothing after it can
				// be code.  Do not key this off end == line.size(): a closing
				// "*/" that happens to be the last two characters of the line
				// would then leave the state stuck inside the comment.
				return;
			}
			continue;
		}

		// Strings come before comment detection: "/*" and "//" inside a
		// string literal are text, not the start of a comment.
		if (line[i] == u8'"' || line[i] == u8'\'' || line[i] == u8'`')
		{
			auto const quote{line[i]};
			auto const begin{i};
			++i;
			while (i < line.size())
			{
				if (line[i] == u8'\\' && i + 1 < line.size())
				{
					i += 2;
					continue;
				}
				if (line[i] == quote)
				{
					++i;
					break;
				}
				++i;
			}
			span_begin(out, u8"s");
			print_escaped(out, ::fast_io::u8string_view{line.data() + begin, i - begin});
			span_end(out);
			first_token = false;
			continue;
		}

		// Line comment.
		if (!line_comment.is_empty() && starts_at(line, i, line_comment))
		{
			span_begin(out, u8"c");
			print_escaped(out, ::fast_io::u8string_view{line.data() + i, line.size() - i});
			span_end(out);
			return;
		}

		// Block comment start.
		if (!block_open.is_empty() && starts_at(line, i, block_open))
		{
			::std::size_t end{line.size()};
			bool closed{};
			if (!block_close.is_empty())
			{
				for (::std::size_t j{i + block_open.size()}; j + block_close.size() <= line.size(); ++j)
				{
					if (starts_at(line, j, block_close))
					{
						end = j + block_close.size();
						closed = true;
						break;
					}
				}
			}
			span_begin(out, u8"c");
			print_escaped(out, ::fast_io::u8string_view{line.data() + i, end - i});
			span_end(out);
			if (!closed)
			{
				state.in_block_comment = true;
				return;
			}
			i = end;
			continue;
		}

		// C/C++-style preprocessor line.
		if (first_token && line[i] == u8'#' &&
			(lang != nullptr && (lang->name == ::fast_io::u8string_view{u8"c"} ||
								 lang->name == ::fast_io::u8string_view{u8"cpp"} ||
								 lang->name == ::fast_io::u8string_view{u8"objc"})))
		{
			span_begin(out, u8"p");
			print_escaped(out, ::fast_io::u8string_view{line.data() + i, line.size() - i});
			span_end(out);
			return;
		}

		// Numbers.
		if (is_digit(line[i]) || (line[i] == u8'.' && i + 1 < line.size() && is_digit(line[i + 1])))
		{
			auto const begin{i};
			++i;
			while (i < line.size())
			{
				auto const c{line[i]};
				if (is_ident_char(c) || c == u8'.' || c == u8'\'' ||
					((c == u8'+' || c == u8'-') && i != begin &&
					 (line[i - 1] == u8'e' || line[i - 1] == u8'E' || line[i - 1] == u8'p' || line[i - 1] == u8'P')))
				{
					++i;
				}
				else
				{
					break;
				}
			}
			span_begin(out, u8"n");
			print_escaped(out, ::fast_io::u8string_view{line.data() + begin, i - begin});
			span_end(out);
			first_token = false;
			continue;
		}

		// Identifiers / keywords.
		if (is_ident_start(line[i]))
		{
			auto const begin{i};
			++i;
			while (i < line.size() && is_ident_char(line[i]))
			{
				++i;
			}
			auto const word{::fast_io::u8string_view{line.data() + begin, i - begin}};
			auto const kind{classify_word(word, lang)};
			if (kind == 1)
			{
				span_begin(out, u8"k");
				print_escaped(out, word);
				span_end(out);
			}
			else if (kind == 2)
			{
				span_begin(out, u8"t");
				print_escaped(out, word);
				span_end(out);
			}
			else
			{
				print_escaped(out, word);
			}
			first_token = false;
			continue;
		}

		// Brackets get VSCode-style depth colours.
		if (line[i] == u8'(' || line[i] == u8'[' || line[i] == u8'{' || line[i] == u8')' ||
			line[i] == u8']' || line[i] == u8'}')
		{
			bool const closing{line[i] == u8')' || line[i] == u8']' || line[i] == u8'}'};
			if (closing && depth > 0)
			{
				--depth;
			}
			auto const slot{static_cast<::std::size_t>(depth % 3)};
			print(out, u8"<span class=\"t-b", slot);
			if (match_offset != SIZE_MAX && line_start + i == match_offset)
			{
				print(out, u8" bm");
			}
			print(out, u8"\">");
			print_escaped_char(out, line[i]);
			span_end(out);
			if (!closing)
			{
				++depth;
			}
			++i;
			first_token = false;
			continue;
		}

		print_escaped_char(out, line[i]);
		first_token = false;
		++i;
	}
}

// Scan a line without rendering to derive the state (and bracket depth) at the
// next line.  Used when a view starts in the middle of a file.
inline void scan_line_full(::fast_io::u8string_view line, keywords::language const *lang,
						   render_state &state, int &depth) noexcept
{
	auto const line_comment{lang ? lang->line_comment : ::fast_io::u8string_view{}};
	auto const block_open{lang ? lang->block_open : ::fast_io::u8string_view{}};
	auto const block_close{lang ? lang->block_close : ::fast_io::u8string_view{}};
	::std::size_t i{};
	while (i < line.size())
	{
		if (state.in_block_comment)
		{
			bool closed{};
			for (; i + block_close.size() <= line.size(); ++i)
			{
				if (starts_at(line, i, block_close))
				{
					state.in_block_comment = false;
					i += block_close.size();
					closed = true;
					break;
				}
			}
			if (!closed)
			{
				return;
			}
			continue;
		}
		auto const c{line[i]};
		// Skip string literals before looking for comment markers, otherwise
		// a "/*" or "//" inside a string would poison the state of every
		// following line.
		if (c == u8'"' || c == u8'\'' || c == u8'`')
		{
			auto const quote{c};
			++i;
			while (i < line.size())
			{
				if (line[i] == u8'\\' && i + 1 < line.size())
				{
					i += 2;
					continue;
				}
				if (line[i] == quote)
				{
					++i;
					break;
				}
				++i;
			}
			continue;
		}
		if (!line_comment.is_empty() && starts_at(line, i, line_comment))
		{
			return;
		}
		if (!block_open.is_empty() && starts_at(line, i, block_open))
		{
			state.in_block_comment = true;
			i += block_open.size();
			continue;
		}
		if (c == u8'(' || c == u8'[' || c == u8'{')
		{
			++depth;
		}
		else if (c == u8')' || c == u8']' || c == u8'}')
		{
			if (depth > 0)
			{
				--depth;
			}
		}
		++i;
	}
}

inline void scan_line(::fast_io::u8string_view line, keywords::language const *lang, render_state &state) noexcept
{
	auto const block_open{lang ? lang->block_open : ::fast_io::u8string_view{}};
	auto const block_close{lang ? lang->block_close : ::fast_io::u8string_view{}};
	::std::size_t i{};
	while (i < line.size())
	{
		if (state.in_block_comment)
		{
			for (; i + block_close.size() <= line.size(); ++i)
			{
				if (starts_at(line, i, block_close))
				{
					state.in_block_comment = false;
					i += block_close.size();
					break;
				}
			}
			if (state.in_block_comment)
			{
				return;
			}
			continue;
		}
		auto const c{line[i]};
		if (c == u8'"' || c == u8'\'' || c == u8'`')
		{
			auto const quote{c};
			++i;
			while (i < line.size())
			{
				if (line[i] == u8'\\' && i + 1 < line.size())
				{
					i += 2;
					continue;
				}
				if (line[i] == quote)
				{
					++i;
					break;
				}
				++i;
			}
			continue;
		}
		if (!block_open.is_empty() && starts_at(line, i, block_open))
		{
			state.in_block_comment = true;
			i += block_open.size();
			continue;
		}
		++i;
	}
}

} // namespace pwa::syntax
