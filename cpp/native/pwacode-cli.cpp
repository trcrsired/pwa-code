// pwa-code native core demo.
//
// This is the portability proof for the editor core: the exact same
// `cpp/core/*.h` headers used by the wasm module compile and run natively with
// fast_io.  It deliberately contains no browser or server code.
//
//   pwacode-cli FILE                 show the first 80 highlighted lines
//   pwacode-cli FILE --lines N       show N lines
//   pwacode-cli FILE --encoding E    decode with encoding id E (0..7)
//   pwacode-cli FILE --save OUT      re-encode to OUT using the source policy
//   pwacode-cli FILE --hex [ROWS]    dump the hex view
//
// Errors are herbceptions only.
#include <fast_io.h>
#include <fast_io_device.h>
#include <fast_io_dsal/string.h>
#include <fast_io_dsal/vector.h>

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "../core/document.h"

namespace fi = ::fast_io;
namespace fop = ::fast_io::operations;

namespace
{

struct options
{
	options() throws = default;
	fi::u8string path;
	fi::u8string save_path;
	::std::size_t lines{80};
	::std::size_t hex_rows{16};
	::std::int_least32_t encoding{-1};
	::std::int_least32_t eol{-1};
	bool hex{};
	bool show_version{};
};

constexpr fi::u8string_view sv(fi::u8string const &s) noexcept
{
	return fi::u8string_view{s.data(), s.size()};
}

// Map the file instead of reading it through pread.  The loader owns the
// mapping for as long as the returned object lives, so the document can index
// the bytes directly and no per-file read loop is needed.
fi::native_file_loader read_file(fi::u8string_view path) throws
{
	return fi::native_file_loader{fi::mnp::os_c_str(path.data())};
}

void write_file(fi::u8string_view path, ::std::byte const *data, ::std::size_t size) throws
{
	fi::u8native_file file{fi::mnp::os_c_str(path.data()),
						   fi::open_mode::out | fi::open_mode::creat | fi::open_mode::trunc};
	fop::write_all_bytes(file, data, size);
}

options parse_args(int argc, char const **argv) throws
{
	options opt{};
	for (int i{1}; i != argc; ++i)
	{
		fi::u8cstring_view const arg{fi::mnp::os_c_str(
			reinterpret_cast<char8_t const *>(argv[i]))};
		if (arg == fi::u8cstring_view{u8"--lines"})
		{
			if (++i == argc) throw throws ::std::errc::invalid_argument;
			opt.lines = fi::u8to<::std::size_t>(fi::u8string_view{
				reinterpret_cast<char8_t const *>(argv[i]), ::std::strlen(argv[i])});
		}
		else if (arg == fi::u8cstring_view{u8"--encoding"})
		{
			if (++i == argc) throw throws ::std::errc::invalid_argument;
			opt.encoding = static_cast<::std::int_least32_t>(fi::u8to<int>(fi::u8string_view{
				reinterpret_cast<char8_t const *>(argv[i]), ::std::strlen(argv[i])}));
		}
		else if (arg == fi::u8cstring_view{u8"--eol"})
		{
			if (++i == argc) throw throws ::std::errc::invalid_argument;
			opt.eol = static_cast<::std::int_least32_t>(fi::u8to<int>(fi::u8string_view{
				reinterpret_cast<char8_t const *>(argv[i]), ::std::strlen(argv[i])}));
		}
		else if (arg == fi::u8cstring_view{u8"--save"})
		{
			if (++i == argc) throw throws ::std::errc::invalid_argument;
			opt.save_path.assign(fi::u8string_view{
				reinterpret_cast<char8_t const *>(argv[i]), ::std::strlen(argv[i])});
		}
		else if (arg == fi::u8cstring_view{u8"--hex"})
		{
			opt.hex = true;
			if (i + 1 != argc && argv[i + 1][0] != '-')
			{
				opt.hex_rows = fi::u8to<::std::size_t>(fi::u8string_view{
					reinterpret_cast<char8_t const *>(argv[++i]), ::std::strlen(argv[i])});
			}
		}
		else if (arg == fi::u8cstring_view{u8"--version"})
		{
			opt.show_version = true;
		}
		else if (arg == fi::u8cstring_view{u8"--help"} || arg == fi::u8cstring_view{u8"-h"})
		{
			fi::io::println("pwacode-cli FILE [--lines N] [--encoding E] [--eol M] "
							"[--save OUT] [--hex [ROWS]]");
			throw throws ::std::errc::invalid_argument;
		}
		else if (opt.path.is_empty())
		{
			opt.path.assign(fi::u8string_view{
				reinterpret_cast<char8_t const *>(argv[i]), ::std::strlen(argv[i])});
		}
		else
		{
			throw throws ::std::errc::invalid_argument;
		}
	}
	return opt;
}

void run(options const &opt) throws
{
	if (opt.show_version)
	{
		fi::io::println("pwa-code core 2");
		return;
	}
	if (opt.path.is_empty())
	{
		throw throws ::std::errc::invalid_argument;
	}

	auto const bytes{read_file(sv(opt.path))};
	auto const raw_size{bytes.size()};
	auto const raw{raw_size != 0 ? reinterpret_cast<::std::byte const *>(bytes.data())
								 : static_cast<::std::byte const *>(nullptr)};
	auto probe{pwa::probe_encoding(raw, raw_size)};
	if (opt.encoding >= 0)
	{
		if (opt.encoding > 7) throw throws ::std::errc::invalid_argument;
		probe.encoding = static_cast<pwa::text_encoding>(opt.encoding);
	}
	fi::u8string text;
	pwa::decode_to_utf8(raw, raw_size, probe, text);

	pwa::document doc{};
	doc.set_text_owned(::std::move(text), true);
	doc.set_path(sv(opt.path));
	doc.set_encoding(probe.encoding, probe.has_bom);
	doc.set_source_crlf(probe.source_crlf);
	doc.load_hex(raw, raw_size);
	if (opt.eol >= 0)
	{
		doc.set_eol_mode(static_cast<pwa::eol_mode>(opt.eol));
	}

	fi::io::println("file: ", fi::mnp::os_c_str(reinterpret_cast<char const *>(opt.path.c_str())));
	auto const enc_name{pwa::encoding_name(probe.encoding)};
	fi::io::println("encoding: ",
					fi::mnp::os_c_str(reinterpret_cast<char const *>(enc_name.data()),
									  enc_name.size()),
					"  bom: ", fi::mnp::os_c_str(probe.has_bom ? "yes" : "no"),
					"  source CRLF: ", fi::mnp::os_c_str(probe.source_crlf ? "yes" : "no"));
	auto const lang_name{doc.language() ? doc.language()->name : fi::u8string_view{u8"plain"}};
	fi::io::println("lines: ", doc.line_count(), "  bytes: ", doc.size(),
					"  language: ",
					fi::mnp::os_c_str(reinterpret_cast<char const *>(lang_name.data()),
									  lang_name.size()));

	if (!opt.save_path.is_empty())
	{
		fi::vector<::std::byte> saved;
		doc.save_bytes(saved);
		write_file(sv(opt.save_path), saved.data(), saved.size());
		fi::io::println("saved: ", fi::mnp::os_c_str(
			reinterpret_cast<char const *>(opt.save_path.c_str())), " (", saved.size(), " bytes)");
	}

	if (opt.hex)
	{
		fi::u8string out;
		doc.render_hex(0, opt.hex_rows, 16, out);
		fi::io::print(fi::u8out(), ::fast_io::mnp::os_c_str(
			reinterpret_cast<char8_t const *>(out.data()), out.size()));
	}
	else
	{
		fi::u8string out;
		doc.render_view(0, opt.lines, true, out);
		fi::io::print(fi::u8out(), ::fast_io::mnp::os_c_str(
			reinterpret_cast<char8_t const *>(out.data()), out.size()));
	}
}

} // namespace

int main(int argc, char const **argv) noexcept
{
	try
	{
		run(parse_args(argc, argv));
		return 0;
	}
	catch throws(::std::error e)
	{
		fi::io::perrln(e);
		return 1;
	}
}
