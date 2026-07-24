# Changelog

All notable changes to ZITEXT Editor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.5] - 2026-07-21

### Fixed
- Fixed caret/selection drift while typing: Monaco now re-measures character widths once web fonts finish loading, so the cursor no longer creeps away from the text with fonts narrower or wider than the fallback.
- Removed duplicate Copy/Cut/Paste entries from the editor right-click menu (kept the cross-platform Tauri clipboard actions).
- **Find in Files** now excludes generated build/cache directories (`.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.angular`, `.vite`, `.parcel-cache`, `.cache`, `.output`, `coverage`) so real source matches aren't crowded out of the result cap, and only shows "No results found" after a search actually runs.
- Relabeled the Explorer filename filter and added a hint pointing to Find in Files, so it is no longer confused with content search.
- **Go to Line** no longer renders an empty popup on Linux (WebKitGTK); it shows the in-app range warning toast instead.
- Empty untitled tabs are no longer persisted, so they stop accumulating and reopening on startup.
- Settings info cards now render with a visible border on Linux (WebKitGTK), and the Settings modal fits its content instead of clipping the Editor tab behind a scrollbar.
- Aligned the search panel's close (×) button in the header.
- Unsaved-changes dialog buttons no longer overlap (added spacing to the action row).
- Files open from the Explorer noticeably faster — the native-menu rebuild is now deferred until after the document renders instead of blocking it.
- Closed renderer path-grant escalation through recent files, project settings, and recovery sessions.
- Made saves atomic, encoding-preserving, revision-aware, and protected against overwriting a newer on-disk version.
- Isolated Monaco models and undo history per tab and restored production language-service workers.
- Made JSON/XML formatting lossless for large numbers, special keys, mixed content, CDATA, and quoted delimiters.
- Repaired CLI paths with spaces, secondary-instance folders, and `--wait` handshakes.
- Added frontend and Rust regression tests plus strict TypeScript, ESLint, rustfmt, Clippy, and test gates in CI.

### Changed
- Replaced the native Font Family control with a custom in-app dropdown.
- Removed the Anonymous Pro and Inconsolata fonts; saved settings that still reference them are migrated back to the default font stack on load.
- Release builds now publish a GitHub Release with installers and checksums automatically on every tag push, kept in sync with the website downloads.

### Security
- Moved session-restore consent to a native one-shot prompt and narrowed Tauri capabilities.
- Added backend payload budgets, regular-file enforcement, native close tokens, safe rename semantics, and immutable pinned CI actions.
- Production releases now require signing verification on every platform, immutable tags, serialized publication, and monotonically increasing update metadata.
- Resolved cargo-audit advisories (crossbeam-epoch, quick-xml via plist) with dated, scoped exceptions for the remaining build-only cases.

## [2.1.4]

### Fixed
- **Find in Files** now opens reliably from the Edit menu, including when the sidebar is collapsed (previously did nothing).
- **Command Palette** is now reachable from the View menu, and `Ctrl`/`Cmd`+`P` opens it instead of triggering the OS print dialog.
- **Right-click Copy/Paste** in the editor now works across platforms (routed through the Tauri clipboard plugin).
- **File Explorer "Refresh"** preserves expanded folders instead of collapsing the tree.
- Fixed a blank window on launch caused by a mismatched `react` / `react-dom` version in the previous 2.1.4 build; both are now pinned to the same release.

### Changed
- Word Wrap setting under Appearance no longer wraps onto two lines.
- Regenerated a multi-resolution Windows icon (`icon.ico`) so the taskbar icon is no longer blurry.
- Updated dependencies (React 19.2.7, marked 18, Tauri 2.11.3) and consolidated CI into a single workflow with grouped Dependabot updates; added a CI guard that fails the build if `react` and `react-dom` versions differ.

### Security
- Added least-privilege `permissions:` blocks to all CI/release workflows.
- Session identifiers now use `crypto.randomUUID()` instead of `Math.random()`.
- Updated the `rand` crate to 0.8.6 (addresses a RUSTSEC advisory).

## [2.1.3]

### Fixed
- Recent files and drag-and-drop now open reliably (previously could fail with "Access denied").
- Closing the app or a tab with unsaved changes now prompts to save instead of silently discarding work.
- Crash-recovery session snapshots are written atomically and no longer lost to concurrent settings writes.

### Changed
- Default font is now Menlo (falls back to Consolas on Windows and a bundled JetBrains Mono on Linux).
- Fonts are bundled and served locally — the app makes no external font requests.

### Security
- Updated DOMPurify to a patched release and deduplicated it across the dependency tree.
- Settings are written atomically and serialized to prevent corruption/clobbering.
- Previous-session file paths and unsaved content are no longer exposed before you choose to restore.

## [2.1.2]

Initial public release baseline. Highlights:

- Tabbed editing with split view, multi-cursor, and column (rectangular) selection
- Syntax highlighting for 60+ languages via Monaco
- Find in file, find in files, and go to line
- JSON/XML/YAML formatting and validation tools
- Markdown preview
- Session restore, recent files, and autosave
- Light/dark themes that follow the OS theme on first launch
- Update notifications with one-click download from the website

[Unreleased]: https://github.com/zitrino-oss/zitext-editor/compare/v2.1.5...HEAD
[2.1.5]: https://github.com/zitrino-oss/zitext-editor/compare/v2.1.4...v2.1.5
[2.1.4]: https://github.com/zitrino-oss/zitext-editor/releases/tag/v2.1.4
[2.1.3]: https://github.com/zitrino-oss/zitext-editor/releases/tag/v2.1.3
[2.1.2]: https://github.com/zitrino-oss/zitext-editor/releases/tag/v2.1.2
