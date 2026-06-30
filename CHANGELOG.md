# Changelog

All notable changes to ZITEXT Editor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Unsaved-changes dialog buttons no longer overlap (added spacing to the action row).
- Files open from the Explorer noticeably faster — the native-menu rebuild is now deferred until after the document renders instead of blocking it.

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

[Unreleased]: https://github.com/zitrino-oss/zitext-editor/compare/v2.1.3...HEAD
[2.1.3]: https://github.com/zitrino-oss/zitext-editor/releases/tag/v2.1.3
[2.1.2]: https://github.com/zitrino-oss/zitext-editor/releases/tag/v2.1.2
