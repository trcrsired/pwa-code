// pwa-code text encoding layer.
//
// All file decoding and encoding goes through fast_io's codecvt engine.  The
// document itself is always UTF-8 internally; this is the only place that
// knows about UTF-16/32, GB18030 and UTF-EBCDIC.
//
// fast_io_unit/gb18030.h contains the (large) GB18030 tables.  It is included
// only here so the rest of the core stays light.
#pragma once

#include <fast_io.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/string_view.h>
#include <fast_io_dsal/vector.h>
#include <fast_io_unit/gb18030.h>

#include <cstddef>
#include <cstdint>

namespace pwa
{

enum class text_encoding : ::std::uint_least8_t
{
	utf8 = 0,
	utf16le = 1,
	utf16be = 2,
	utf32le = 3,
	utf32be = 4,
	gb18030 = 5,
	utf_ebcdic = 6,
	binary = 7
};

struct encoding_probe
{
	text_encoding encoding{text_encoding::utf8};
	bool has_bom{};
	::std::size_t bom_length{};
	bool source_crlf{};
};

inline constexpr ::fast_io::u8string_view encoding_name(text_encoding e) noexcept
{
	switch (e)
	{
	case text_encoding::utf8: return u8"UTF-8";
	case text_encoding::utf16le: return u8"UTF-16LE";
	case text_encoding::utf16be: return u8"UTF-16BE";
	case text_encoding::utf32le: return u8"UTF-32LE";
	case text_encoding::utf32be: return u8"UTF-32BE";
	case text_encoding::gb18030: return u8"GB18030";
	case text_encoding::utf_ebcdic: return u8"UTF-EBCDIC";
	default: return u8"Binary";
	}
}

inline constexpr bool encoding_is_unicode(text_encoding e) noexcept
{
	return e == text_encoding::utf8 || e == text_encoding::utf16le || e == text_encoding::utf16be ||
		   e == text_encoding::utf32le || e == text_encoding::utf32be || e == text_encoding::utf_ebcdic;
}

// Canonical BOM for an encoding.  Returns an empty view when the encoding has
// no BOM (GB18030 and "binary").
inline constexpr ::fast_io::u8string_view bom_for(text_encoding e) noexcept
{
	switch (e)
	{
	case text_encoding::utf8: return u8"\xEF\xBB\xBF";
	case text_encoding::utf16le: return u8"\xFF\xFE";
	case text_encoding::utf16be: return u8"\xFE\xFF";
	case text_encoding::utf32le: return u8"\xFF\xFE\x00\x00";
	case text_encoding::utf32be: return u8"\x00\x00\xFE\xFF";
	case text_encoding::gb18030: return u8"\x84\x31\x95\x33";
	case text_encoding::utf_ebcdic: return u8"\xDD\x73\x66\x73";
	default: return {};
	}
}

inline bool bytes_start_with(::std::byte const *data, ::std::size_t size,
							 ::fast_io::u8string_view prefix) noexcept
{
	if (size < prefix.size())
	{
		return false;
	}
	for (::std::size_t i{}; i != prefix.size(); ++i)
	{
		if (static_cast<::std::uint_least8_t>(data[i]) != static_cast<::std::uint_least8_t>(prefix[i]))
		{
			return false;
		}
	}
	return true;
}

// Detect encoding by BOM first, then by structural validation.  UTF-8 is the
// default for BOM-less text because it is the web/document interchange format.
inline encoding_probe probe_encoding(::std::byte const *data, ::std::size_t size) noexcept
{
	encoding_probe p{};
	// Longest BOMs first: FF FE is a valid prefix of the UTF-32LE BOM.
	if (bytes_start_with(data, size, bom_for(text_encoding::utf32le)))
	{
		p = {text_encoding::utf32le, true, 4, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::utf32be)))
	{
		p = {text_encoding::utf32be, true, 4, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::utf8)))
	{
		p = {text_encoding::utf8, true, 3, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::utf16le)))
	{
		p = {text_encoding::utf16le, true, 2, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::utf16be)))
	{
		p = {text_encoding::utf16be, true, 2, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::utf_ebcdic)))
	{
		p = {text_encoding::utf_ebcdic, true, 4, false};
	}
	else if (bytes_start_with(data, size, bom_for(text_encoding::gb18030)))
	{
		p = {text_encoding::gb18030, true, 4, false};
	}
	else
	{
		// No BOM.  NUL-heavy even-length data is almost always UTF-16/32.
		p.encoding = text_encoding::utf8;
		if (size >= 4 && (size % 4) == 0)
		{
			::std::size_t zero_every_fourth{};
			for (::std::size_t i{}; i + 3 < size && i < 4096; i += 4)
			{
				if (data[i] == ::std::byte{} && data[i + 1] == ::std::byte{} &&
					data[i + 2] == ::std::byte{} && data[i + 3] != ::std::byte{})
				{
					++zero_every_fourth;
				}
			}
			if (zero_every_fourth > 4)
			{
				p.encoding = text_encoding::utf32be;
			}
		}
		if (p.encoding == text_encoding::utf8 && size >= 4 && (size % 2) == 0)
		{
			::std::size_t zero_odd{};
			::std::size_t zero_even{};
			for (::std::size_t i{}; i + 1 < size && i < 4096; i += 2)
			{
				zero_even += data[i] == ::std::byte{};
				zero_odd += data[i + 1] == ::std::byte{};
			}
			if (zero_odd > 8 && zero_even < 2)
			{
				p.encoding = text_encoding::utf16le;
			}
			else if (zero_even > 8 && zero_odd < 2)
			{
				p.encoding = text_encoding::utf16be;
			}
		}
	}

	// EOL policy is a property of the bytes, not the encoding: the document
	// keeps LF internally and restores CRLF only when the source had it.
	if (size != 0)
	{
		::std::size_t crlf{};
		::std::size_t lf{};
		int stride{1};
		if (p.encoding == text_encoding::utf16le || p.encoding == text_encoding::utf16be)
		{
			stride = 2;
		}
		else if (p.encoding == text_encoding::utf32le || p.encoding == text_encoding::utf32be)
		{
			stride = 4;
		}
		for (::std::size_t i{p.bom_length}; i + static_cast<::std::size_t>(stride) <= size; i += static_cast<::std::size_t>(stride))
		{
			// Compare a NUL-free unit by its low byte only for UTF-16/32
			// little-endian on little-endian hosts; for detection purposes
			// looking at every byte for a plain UTF-8 file is enough and the
			// UTF-16 path is refined below by inspecting both bytes.
			if (stride == 1)
			{
				if (data[i] == static_cast<::std::byte>('\n'))
				{
					++lf;
				}
				else if (data[i] == static_cast<::std::byte>('\r') && i + 1 < size &&
						 data[i + 1] == static_cast<::std::byte>('\n'))
				{
					++crlf;
				}
			}
			else if (stride == 2)
			{
				auto const b0{static_cast<::std::uint_least8_t>(data[i])};
				auto const b1{static_cast<::std::uint_least8_t>(data[i + 1])};
				bool const le{p.encoding == text_encoding::utf16le};
				auto const unit{static_cast<::std::uint_least16_t>(le ? (b0 | (b1 << 8)) : ((b0 << 8) | b1))};
				if (unit == u'\n')
				{
					++lf;
				}
				else if (unit == u'\r' && i + 3 < size &&
						 static_cast<::std::uint_least8_t>(data[i + (le ? 2 : 0)]) == (le ? 0x0A : 0x00) &&
						 static_cast<::std::uint_least8_t>(data[i + (le ? 3 : 1)]) == (le ? 0x00 : 0x0A))
				{
					++crlf;
				}
			}
		}
		p.source_crlf = crlf != 0 && crlf * 2 >= lf;
	}
	return p;
}

namespace details
{

template <typename unit_type, ::fast_io::encoding_scheme scheme>
inline void decode_units(::std::byte const *data, ::std::size_t size, ::fast_io::u8string &out) throws
{
	::fast_io::vector<unit_type> units;
	units.resize(size / sizeof(unit_type));
	if (units.size() != 0)
	{
		__builtin_memcpy(units.data(), data, units.size() * sizeof(unit_type));
	}
	::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(out)};
	::fast_io::io::print(
		writer, ::fast_io::mnp::code_cvt<scheme, ::fast_io::encoding_scheme::utf>(
					::fast_io::basic_io_scatter_t<unit_type>{units.data(), units.size()}));
}

template <::fast_io::encoding_scheme scheme>
inline void decode_bytes(::std::byte const *data, ::std::size_t size, ::fast_io::u8string &out) throws
{
	::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(out)};
	::fast_io::io::print(
		writer, ::fast_io::mnp::code_cvt<scheme, ::fast_io::encoding_scheme::utf>(
					::fast_io::basic_io_scatter_t<char8_t>{
						reinterpret_cast<char8_t const *>(data), size}));
}

template <typename unit_type, ::fast_io::encoding_scheme scheme>
inline void encode_units(::fast_io::u8string_view text, ::fast_io::vector<::std::byte> &out) throws
{
	::fast_io::basic_string<unit_type> units;
	::fast_io::containers::basic_ostring_ref_fast_io<unit_type, ::fast_io::native_global_allocator> writer{
		__builtin_addressof(units)};
	::fast_io::io::print(
		writer, ::fast_io::mnp::code_cvt<::fast_io::encoding_scheme::utf, scheme>(
					::fast_io::basic_io_scatter_t<char8_t>{text.data(), text.size()}));
	auto const bytes{units.size() * sizeof(unit_type)};
	auto const old{out.size()};
	out.resize(old + bytes);
	if (bytes != 0)
	{
		__builtin_memcpy(out.data() + old, units.data(), bytes);
	}
}

template <::fast_io::encoding_scheme scheme>
inline void encode_bytes(::fast_io::u8string_view text, ::fast_io::vector<::std::byte> &out) throws
{
	::fast_io::u8string bytes;
	::fast_io::u8ostring_ref_fast_io writer{__builtin_addressof(bytes)};
	::fast_io::io::print(
		writer, ::fast_io::mnp::code_cvt<::fast_io::encoding_scheme::utf, scheme>(
					::fast_io::basic_io_scatter_t<char8_t>{text.data(), text.size()}));
	auto const old{out.size()};
	out.resize(old + bytes.size());
	if (bytes.size() != 0)
	{
		__builtin_memcpy(out.data() + old, bytes.data(), bytes.size());
	}
}

} // namespace details

// Decode file bytes into the document's canonical UTF-8 representation.
// The BOM, if present, is stripped.  Returns false for an unknown/binary file.
inline void decode_to_utf8(::std::byte const *data, ::std::size_t size, encoding_probe const &probe,
						   ::fast_io::u8string &out) throws
{
	out.clear();
	auto const offset{probe.bom_length};
	if (offset > size)
	{
		throw throws ::std::errc::illegal_byte_sequence;
	}
	data += offset;
	size -= offset;
	switch (probe.encoding)
	{
	case text_encoding::utf8:
		out.append(reinterpret_cast<char8_t const *>(data), size);
		return;
	case text_encoding::utf16le:
		details::decode_units<char16_t, ::fast_io::encoding_scheme::utf_le>(data, size, out);
		return;
	case text_encoding::utf16be:
		details::decode_units<char16_t, ::fast_io::encoding_scheme::utf_be>(data, size, out);
		return;
	case text_encoding::utf32le:
		details::decode_units<char32_t, ::fast_io::encoding_scheme::utf_le>(data, size, out);
		return;
	case text_encoding::utf32be:
		details::decode_units<char32_t, ::fast_io::encoding_scheme::utf_be>(data, size, out);
		return;
	case text_encoding::gb18030:
		details::decode_bytes<::fast_io::encoding_scheme::gb18030>(data, size, out);
		return;
	case text_encoding::utf_ebcdic:
		details::decode_bytes<::fast_io::encoding_scheme::utf_ebcdic>(data, size, out);
		return;
	default:
		throw throws ::std::errc::illegal_byte_sequence;
	}
}

// Encode canonical UTF-8 back to the file encoding, adding the BOM when the
// file had one (or when the caller explicitly requests it).
inline void encode_from_utf8(::fast_io::u8string_view text, text_encoding encoding, bool emit_bom,
							 ::fast_io::vector<::std::byte> &out) throws
{
	out.clear();
	if (emit_bom)
	{
		auto const bom{bom_for(encoding)};
		out.resize(bom.size());
		for (::std::size_t i{}; i != bom.size(); ++i)
		{
			out[i] = static_cast<::std::byte>(static_cast<::std::uint_least8_t>(bom[i]));
		}
	}
	switch (encoding)
	{
	case text_encoding::utf8:
	{
		auto const old{out.size()};
		out.resize(old + text.size());
		if (text.size() != 0)
		{
			__builtin_memcpy(out.data() + old, text.data(), text.size());
		}
		break;
	}
	case text_encoding::utf16le:
		details::encode_units<char16_t, ::fast_io::encoding_scheme::utf_le>(text, out);
		break;
	case text_encoding::utf16be:
		details::encode_units<char16_t, ::fast_io::encoding_scheme::utf_be>(text, out);
		break;
	case text_encoding::utf32le:
		details::encode_units<char32_t, ::fast_io::encoding_scheme::utf_le>(text, out);
		break;
	case text_encoding::utf32be:
		details::encode_units<char32_t, ::fast_io::encoding_scheme::utf_be>(text, out);
		break;
	case text_encoding::gb18030:
		details::encode_bytes<::fast_io::encoding_scheme::gb18030>(text, out);
		break;
	case text_encoding::utf_ebcdic:
		details::encode_bytes<::fast_io::encoding_scheme::utf_ebcdic>(text, out);
		break;
	default:
	{
		auto const old{out.size()};
		out.resize(old + text.size());
		if (text.size() != 0)
		{
			__builtin_memcpy(out.data() + old, text.data(), text.size());
		}
		break;
	}
	}
}

} // namespace pwa
