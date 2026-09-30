# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.2.0] - 2026-09-30

### Added

- Changelog
- New module: Sqlite
- New function: HttpServer.Response.appendHeader

### Fixed

- ChildProcess.spawn could crash the program
- ChildProcess.spawn with NoShell would fail when arguments were provided
- ChildProcess.run could return null as an error code, instead of an int
- FileSystem.FileHandle.writeFromOffset ignored offset
- FileSystem.makeTempDirectory would crash program on error
- HttpClient.withBytesBody could send more bytes than requested
- HttpClient.send response had corrupted errors
