# Contributing to ZITEXT Editor

Thanks for your interest in contributing! This document covers how to set up the
project, the quality bar for changes, and how to submit them.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js** 22 LTS (see `.nvmrc`)
- **Rust** 1.93.0 (installed automatically from `rust-toolchain.toml`)
- **Tauri prerequisites** for your platform — https://tauri.app/start/prerequisites/
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Microsoft Visual Studio C++ Build Tools
  - Linux: see the Tauri prerequisites page (WebKitGTK, etc.)

## Getting started

```bash
git clone https://github.com/zitrino-oss/zitext-editor.git
cd zitext-editor
npm install
npm run tauri dev
```

## Development workflow

| Task | Command |
|------|---------|
| Run the app (hot reload) | `npm run tauri dev` |
| Type-check + build frontend | `npm run build` |
| Lint | `npm run lint` |
| Frontend unit tests | `npm test` |
| Production bundle | `npm run tauri build` |
| Format Rust | `cargo fmt` (in `src-tauri/`) |
| Test Rust | `cargo test --locked` (in `src-tauri/`) |
| Lint Rust | `cargo clippy --locked --all-targets -- -D warnings` (in `src-tauri/`) |

The frontend lives in `src/`, the Rust backend in `src-tauri/`. See the
[README](README.md#project-structure) for a project-structure overview.

### Performance benchmarks

Run the production-core Criterion suite with:

```bash
cd src-tauri
cargo bench --bench file_operations -- --output-format bencher 2>&1 | tee bench-output.txt
node ../scripts/check-benchmark-thresholds.mjs bench-output.txt
```

The second command is a gate: it fails if a required result is missing or a
read, write, search, directory, or authority benchmark exceeds its documented
threshold.

## Submitting changes

1. Fork the repo and create a topic branch (`git checkout -b fix/short-description`).
2. Keep changes focused; one logical change per pull request.
3. Make sure `npm run build`, `npm run lint -- --max-warnings=0`, `npm test`,
   `cargo test --locked`, and strict Clippy pass.
4. Write a clear PR description explaining the change and linking any related
   issue. Fill in the pull request template.
5. Comments should describe what the code does — please avoid narrative or
   changelog-style comments in source.

## Reporting bugs and requesting features

Use the issue templates under **New issue**. For security issues, do **not** open
a public issue — see [SECURITY.md](SECURITY.md).
