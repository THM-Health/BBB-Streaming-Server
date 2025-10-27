# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Worker: Option to set Chrome version on build time ([#290])
- Controller: Option to set minimum number of workers required for the health check to pass ([#258])
- CI: Workflow to update chrome version ([#291])

## [v1.1.1] - 2025-06-16

### Changed

- Dumped dependencies

## [v1.1.0] - 2025-05-12

### Changed

- Dumped dependencies

### Fixed

- Audio join flow for BBB 3.0 servers with listenOnlyMode=false and livekit ([#107], [#113])

## [v1.0.0] - 2025-04-28

### Added

- Worker: Puppeteer Bot to join BBB Meeting and streaming to RTMP endpoint using FFmpeg
- Controller: Create and control jobs to stream BBB Meetings
- Docs: Readme + OpenAPI

[#107]: https://github.com/THM-Health/BBB-Streaming-Server/pull/107
[#113]: https://github.com/THM-Health/BBB-Streaming-Server/pull/113
[#290]: https://github.com/THM-Health/BBB-Streaming-Server/pull/290
[#291]: https://github.com/THM-Health/BBB-Streaming-Server/pull/291
[#258]: https://github.com/THM-Health/BBB-Streaming-Server/pull/258


[unreleased]: https://github.com/THM-Health/BBB-Streaming-Server/compare/v1.1.1...main
[v1.0.0]: https://github.com/THM-Health/BBB-Streaming-Server/releases/tag/v1.0.0
[v1.1.0]: https://github.com/THM-Health/BBB-Streaming-Server/releases/tag/v1.1.0
[v1.1.1]: https://github.com/THM-Health/BBB-Streaming-Server/releases/tag/v1.1.1
