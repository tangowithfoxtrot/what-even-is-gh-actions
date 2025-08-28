# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0-bin](https://github.com/tangowithfoxtrot/what-even-is-gh-actions/releases/tag/v3.0.0-bin) - 2025-08-28

### Added

- GH Release downloads

### Fixed

- only print debug messages if runner debug vars are set
- wrong env var names used for inputs ([#2](https://github.com/tangowithfoxtrot/what-even-is-gh-actions/pull/2))
- bin path

### Other

- use distinct name and version for Rust bin
- make output similar to existing sm-action
- separate concerns and make more readable
- fix clippy lints
- test new `set_env` feature
- whatever
- init
