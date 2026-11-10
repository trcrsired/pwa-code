// Minimal WASI preview1 filesystem layer.
//
// The browser volume code lives in JavaScript, but the same portable core can
// also run inside a WASI runtime (wasmtime, wasmer, Node's WASI, the native
// pwa-code server, ...).  This header gives that build a tiny, herbception-only
// file API on top of the WASI/1 syscalls:
//
//   path_open  fd_read  fd_write  fd_seek  fd_close  fd_readdir
//
// It is deliberately small: no C errno returns, no boolean status results.
// Every failure is translated into `::std::errc` and thrown with `throw throws`.
// On non-WASI targets the wasm-only functions throw `function_not_supported`;
// the native player uses fast_io's native files directly instead.
//
// WASI errno values: https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
#pragma once

#include <fast_io.h>
#include <fast_io_dsal/vector.h>

#include <cstddef>
#include <cstdint>
#include <system_error>

namespace pwa::wasi
{

// WASI preview1 errno values that this layer can produce.
enum class errno_t : ::std::int32_t
{
	success = 0,
	badf = 8,
	exist = 20,
	fault = 21,
	inval = 28,
	io = 29,
	isdir = 31,
	loop = 32,
	noent = 44,
	nomem = 48,
	nosys = 52,
	notdir = 54,
	notempty = 55,
	perm = 63,
	spipe = 70,
	notcapable = 76,
};

#if defined(__wasi__) || defined(__wasm32__)

extern "C"
{
	struct wasi_iovec
	{
		void *buf;
		::std::size_t buf_len;
	};

	struct wasi_dirent
	{
		::std::uint_least64_t d_next;
		::std::uint_least64_t d_ino;
		::std::uint_least32_t d_namlen;
		::std::uint_least8_t d_type;
	};

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("path_open")))
	::std::int_least32_t path_open(::std::int_least32_t fd, ::std::int_least32_t dirflags, char const *path,
			  ::std::size_t path_len, ::std::int_least32_t oflags,
			  ::std::uint_least64_t fs_rights_base, ::std::uint_least64_t fs_rights_inheriting,
			  ::std::int_least32_t fdflags, ::std::int_least32_t *opened_fd);

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("fd_read")))
	::std::int_least32_t fd_read(::std::int_least32_t fd, wasi_iovec const *iovs, ::std::size_t iovs_len,
			::std::size_t *nread);

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("fd_write")))
	::std::int_least32_t fd_write(::std::int_least32_t fd, wasi_iovec const *iovs, ::std::size_t iovs_len,
			 ::std::size_t *nwritten);

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("fd_seek")))
	::std::int_least32_t fd_seek(::std::int_least32_t fd, ::std::int_least64_t offset, ::std::int_least32_t whence,
			::std::uint_least64_t *newoffset);

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("fd_close")))
	::std::int_least32_t fd_close(::std::int_least32_t fd);

	__attribute__((import_module("wasi_snapshot_preview1"), import_name("fd_readdir")))
	::std::int_least32_t fd_readdir(::std::int_least32_t fd, void *buf, ::std::size_t buf_len,
			   ::std::uint_least64_t cookie, ::std::size_t *bufused);
}

inline constexpr ::std::uint_least64_t right_fd_read{1u << 1};
inline constexpr ::std::uint_least64_t right_fd_seek{1u << 2};
inline constexpr ::std::uint_least64_t right_fd_tell{1u << 5};
inline constexpr ::std::uint_least64_t right_fd_write{1u << 6};
inline constexpr ::std::uint_least64_t right_fd_filestat_get{1u << 21};

inline constexpr ::std::int_least32_t oflag_creat{1};
inline constexpr ::std::int_least32_t oflag_directory{2};
inline constexpr ::std::int_least32_t oflag_excl{4};
inline constexpr ::std::int_least32_t oflag_trunc{8};

inline constexpr ::std::int_least32_t seek_set{0};
inline constexpr ::std::int_least32_t seek_cur{1};
inline constexpr ::std::int_least32_t seek_end{2};

// The first preopened directory is usually fd 3 in WASI preview1.
inline constexpr ::std::int_least32_t preopen_root{3};

[[noreturn]] inline void throw_errno(::std::int_least32_t code) throws
{
	switch (static_cast<errno_t>(code))
	{
	case errno_t::badf: throw throws ::std::errc::bad_file_descriptor;
	case errno_t::exist: throw throws ::std::errc::file_exists;
	case errno_t::inval: throw throws ::std::errc::invalid_argument;
	case errno_t::isdir: throw throws ::std::errc::is_a_directory;
	case errno_t::noent: throw throws ::std::errc::no_such_file_or_directory;
	case errno_t::nomem: throw throws ::std::errc::not_enough_memory;
	case errno_t::nosys: throw throws ::std::errc::function_not_supported;
	case errno_t::notdir: throw throws ::std::errc::not_a_directory;
	case errno_t::notempty: throw throws ::std::errc::directory_not_empty;
	case errno_t::perm: throw throws ::std::errc::permission_denied;
	case errno_t::notcapable: throw throws ::std::errc::operation_not_permitted;
	default: throw throws ::std::errc::io_error;
	}
}

// A move-only WASI file descriptor.  The destructor closes the fd but never
// throws (errors from close are ignored on destruction, as in fast_io).
class file
{
public:
	file() noexcept = default;
	explicit file(::std::int_least32_t fd) noexcept : fd_(fd) {}
	file(file const &) = delete;
	file &operator=(file const &) = delete;
	file(file &&other) noexcept : fd_(other.fd_) { other.fd_ = -1; }
	file &operator=(file &&other) noexcept
	{
		if (this != __builtin_addressof(other))
		{
			close_noexcept();
			fd_ = other.fd_;
			other.fd_ = -1;
		}
		return *this;
	}
	~file() noexcept { close_noexcept(); }

	static file open_read(char const *path, ::std::size_t len) throws
	{
		return open_impl(path, len, right_fd_read | right_fd_seek | right_fd_tell,
						 0, oflag_creat);
	}

	static file open_write(char const *path, ::std::size_t len, bool create, bool truncate) throws
	{
		::std::int_least32_t flags{};
		if (create) flags |= oflag_creat;
		if (truncate) flags |= oflag_trunc;
		return open_impl(path, len, right_fd_write | right_fd_seek | right_fd_tell,
						 0, flags);
	}

	static file open_dir(char const *path, ::std::size_t len) throws
	{
		return open_impl(path, len, right_fd_read, 0, oflag_directory);
	}

	[[nodiscard]] bool is_open() const noexcept { return fd_ >= 0; }
	[[nodiscard]] ::std::int_least32_t native_handle() const noexcept { return fd_; }

	[[nodiscard]] ::std::size_t read_some(void *buf, ::std::size_t len) throws
	{
		wasi_iovec const iov{buf, len};
		::std::size_t got{};
		auto const rc{fd_read(fd_, __builtin_addressof(iov), 1, __builtin_addressof(got))};
		if (rc != 0) throw_errno(rc);
		return got;
	}

	[[nodiscard]] ::std::size_t write_some(void const *buf, ::std::size_t len) throws
	{
		wasi_iovec const iov{const_cast<void *>(buf), len};
		::std::size_t put{};
		auto const rc{fd_write(fd_, __builtin_addressof(iov), 1, __builtin_addressof(put))};
		if (rc != 0) throw_errno(rc);
		return put;
	}

	void write_all(void const *buf, ::std::size_t len) throws
	{
		auto const *p{static_cast<::std::byte const *>(buf)};
		while (len != 0)
		{
			auto const n{write_some(p, len)};
			if (n == 0) throw throws ::std::errc::broken_pipe;
			p += n;
			len -= n;
		}
	}

	[[nodiscard]] ::std::uint_least64_t seek(::std::int_least64_t offset,
											 ::std::int_least32_t whence) throws
	{
		::std::uint_least64_t pos{};
		auto const rc{fd_seek(fd_, offset, whence, __builtin_addressof(pos))};
		if (rc != 0) throw_errno(rc);
		return pos;
	}

	void close() throws
	{
		if (fd_ >= 0)
		{
			auto const rc{fd_close(fd_)};
			fd_ = -1;
			if (rc != 0) throw_errno(rc);
		}
	}

private:
	static file open_impl(char const *path, ::std::size_t len,
						  ::std::uint_least64_t rights, ::std::uint_least64_t inherit,
						  ::std::int_least32_t oflags) throws
	{
		::std::int_least32_t fd{-1};
		auto const rc{path_open(preopen_root, 1, path, len, oflags, rights, inherit, 0,
								__builtin_addressof(fd))};
		if (rc != 0) throw_errno(rc);
		return file{fd};
	}

	void close_noexcept() noexcept
	{
		if (fd_ >= 0)
		{
			(void)fd_close(fd_);
			fd_ = -1;
		}
	}

	::std::int_least32_t fd_{-1};
};

// Convenience: read a whole file into a fast_io byte vector.
inline ::fast_io::vector<::std::byte> read_all(char const *path, ::std::size_t len) throws
{
	file f{file::open_read(path, len)};
	::fast_io::vector<::std::byte> out;
	::std::byte chunk[16384];
	for (;;)
	{
		auto const n{f.read_some(chunk, sizeof(chunk))};
		if (n == 0) break;
		auto const old{out.size()};
		out.resize(old + n);
		__builtin_memcpy(out.data() + old, chunk, n);
	}
	return out;
}

inline void write_all(char const *path, ::std::size_t len, void const *data,
					  ::std::size_t size) throws
{
	file f{file::open_write(path, len, true, true)};
	f.write_all(data, size);
	f.close();
}

#else

// Native builds use fast_io's own portable file APIs.  These stubs exist so
// that code which mentions the WASI volume still compiles on the host and
// reports the correct failure instead of silently returning a status code.
class file
{
public:
	file() noexcept = default;
	explicit file(::std::int_least32_t) noexcept {}
	[[nodiscard]] bool is_open() const noexcept { return false; }
	[[nodiscard]] ::std::int_least32_t native_handle() const noexcept { return -1; }
	void close() throws {}
};

[[noreturn]] inline void throw_not_wasi() throws
{
	throw throws ::std::errc::function_not_supported;
}

inline file open_read(char const *, ::std::size_t) throws { throw_not_wasi(); }
inline file open_write(char const *, ::std::size_t, bool, bool) throws { throw_not_wasi(); }
inline file open_dir(char const *, ::std::size_t) throws { throw_not_wasi(); }

#endif

} // namespace pwa::wasi
