# ZITEXT Editor

A fast, lightweight, cross-platform text and code editor built with Tauri v2,
React, TypeScript, and the Monaco Editor. Simple, fast, and feature-rich.

## Features

### File operations
- New file, Open file, Save, Save As, Close tab
- Unsaved-changes confirmation
- Autosave (after delay or on focus change)
- Recent files
- **Large File and Log viewer** (**File → Open Large File or Log…**): opens files of any size read-only without loading them whole; follows a growing log (with rotation detection), filters lines in or out by text or regular expression, highlights log levels, HTTP status codes, request IDs and your own keywords, goes to a line, a percentage or a time, bookmarks lines, and exports filtered, highlighted, selected or bookmarked lines to a new file. Files over the editor's 10 MB limit are offered here automatically.
- **Scratchpad** (**Tools → Open Scratchpad**, `Cmd/Ctrl+Shift+N`): a note with no file name and no Save dialog; it saves itself as you type and is there on the next launch
- Crash recovery: after a crash or forced quit, ZITEXT offers to reopen your files and unsaved changes (a normal quit starts with a fresh window)

### Editing
- Multiple tabs
- Split view (side-by-side editing, `Ctrl/Cmd+\`)
- Syntax highlighting for 80+ language modes; common file names and extensions are auto-detected
- Multi-cursor editing
- Column (rectangular) selection (Alt+Shift+Drag once **Column Selection** is turned on in Settings, or middle mouse button)
- Find in file, Find in files, and Go to line
- **Marks** (**Tools → Mark Selection**, `Cmd/Ctrl+Shift+M`, or **Mark** in the Find bar): keep every occurrence of a word, phrase or regular expression highlighted in one of six colours as you edit; step through them with `F4` / `Shift+F4`
- **File Compare** (**File → Compare**): compare the current document with another file, another open tab, the clipboard, or its saved version on disk, side by side or inline, with changed characters marked; step through changes, copy them from one side to the other, and ignore whitespace, case or blank lines
- Word wrap, read-only mode, current-line highlighting, minimap

### Data tools
- JSON: format, minify, validate, sort keys
- XML: format, minify and validate
- YAML: format
- Markdown preview
- **Text and Data Tools** (**Tools** menu or the command palette): sort lines (A–Z, Z–A, numerically), remove duplicate or empty lines, trim, reverse, join, split and count unique lines; upper, lower and title case; URL, Base64, HTML and JSON encode/decode; decode a JWT (locally, signature not checked); insert a UUID; SHA-256 and MD5 checksums; Unix timestamp ↔ date; CSV ↔ JSON, TSV ↔ JSON and CSV ↔ TSV. Tools work on the selection, or the whole document when nothing is selected; conversions open in a new tab

### Appearance
- Light/dark themes that follow the OS theme on first launch
- Font family, font size, and zoom controls

### Status bar
- Line/column, language mode, encoding, and line-ending type (LF, CRLF, or Mixed)

## Prerequisites

- **Node.js** 22.22.2 or a later 22.x release (see `.nvmrc`; locked dev dependencies such as jsdom need it)
- **Rust** 1.93.0 (installed automatically from `rust-toolchain.toml`)
- **Tauri prerequisites** for your platform — https://tauri.app/start/prerequisites/
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Microsoft Visual Studio C++ Build Tools
  - Linux: WebKitGTK and related packages (see the Tauri page above)

## Getting started

```bash
git clone https://github.com/zitrino-oss/zitext-editor.git
cd zitext-editor
npm install
npm run tauri dev
```

`npm run tauri dev` starts the Vite dev server, compiles the Rust backend, and
launches the app window with hot reload.

## Building for production

```bash
npm run tauri build
```

Bundles are written to:
- **macOS**: `src-tauri/target/release/bundle/dmg/`
- **Windows**: `src-tauri/target/release/bundle/msi/` and `nsis/`
- **Linux**: `src-tauri/target/release/bundle/appimage/` and `deb/`

## Command-line wrapper

The macOS/Linux wrapper is `scripts/zitext`. The app packages don't install it
yet; copy it to a folder on your `PATH` to use it. It accepts files and folders,
with absolute or relative paths:

```bash
zitext path/to/file.txt
zitext --wait path/to/file.txt
```

`--wait` blocks until every regular file from that invocation is closed. It
returns nonzero if ZITEXT does not accept the request, stops heartbeating, or
exceeds the wait timeout, making it safe for tools such as `git commit`.
Folders are opened but are not waited on; nonexistent paths are currently
ignored.

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| New file | `Cmd/Ctrl+N` |
| Open file | `Cmd/Ctrl+O` |
| Save / Save As | `Cmd/Ctrl+S` / `Cmd/Ctrl+Shift+S` |
| Close tab | `Cmd/Ctrl+W` |
| Find / Replace | `Cmd/Ctrl+F` / `Ctrl+H` (`Cmd+Option+F` on macOS) |
| Find in files | `Cmd/Ctrl+Shift+F` |
| Go to line | `Cmd/Ctrl+G` |
| Command palette | `Cmd/Ctrl+Shift+P` |
| Toggle split view | `Cmd/Ctrl+\` |
| Markdown preview | `Cmd/Ctrl+Shift+V` |
| Increase / decrease font size | `Cmd/Ctrl+=` (or `+`) / `Cmd/Ctrl+-` |
| Compare: next / previous change | `Alt+F5` / `Shift+Alt+F5` |
| Log viewer: next / previous bookmark, add bookmark | `F2` / `Shift+F2`, `Cmd/Ctrl+F2` |
| Open Scratchpad | `Cmd/Ctrl+Shift+N` |
| Mark selection / next / previous marked | `Cmd/Ctrl+Shift+M` / `F4` / `Shift+F4` |

Shortcuts are customizable from **Settings → Keyboard Shortcuts**.

## Supported languages

Common file extensions are detected automatically, and additional modes can be
selected from the language menu. The 80+ available modes include JavaScript,
TypeScript, HTML, CSS/SCSS/Less,
JSON, XML, YAML, TOML, Python, Java, C/C++, C#, Go, Rust, Ruby, PHP, Swift,
Kotlin, Scala, shell scripts, PowerShell, SQL (including MySQL and PostgreSQL),
Markdown, MDX, Dockerfile, Makefile, Terraform, Protocol Buffers, SystemVerilog,
Visual Basic, and more.

## Configuration

Settings are stored as JSON in the app config directory:
- **macOS**: `~/Library/Application Support/com.zitrino.zitext/settings.json`
- **Windows**: `%APPDATA%/com.zitrino.zitext/settings.json`
- **Linux**: `~/.config/com.zitrino.zitext/settings.json`

On first launch (no settings file yet) the theme follows your operating system's
light/dark preference; after that, your in-app choice is remembered.

## Security

ZITEXT ships with a strict Content Security Policy and a backend file-authority
model that treats the renderer as untrusted. Update notifications link to the
downloads page for a manual install (there is no in-app auto-updater). See
[SECURITY.md](SECURITY.md) for the full security model and how to report a
vulnerability.

## Project structure

```
.
├── src/                  # Frontend (React + TypeScript)
│   ├── components/        # UI components
│   ├── state/             # State hooks (tabs, files, settings, split view)
│   ├── hooks/             # Reusable hooks
│   ├── services/          # App services (errors, themes)
│   ├── utils/             # File ops, language detection, data tools
│   ├── types/             # Shared TypeScript types
│   ├── App.tsx            # Root component
│   ├── main.tsx           # React entry point
│   └── styles.css         # Global styles
├── src-tauri/            # Backend (Rust + Tauri)
│   ├── src/lib.rs         # Tauri commands
│   ├── Cargo.toml         # Rust dependencies
│   └── tauri.conf.json    # Tauri configuration
├── package.json
└── README.md
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
quality bar, and the pull-request process. Please also read our
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Tech stack

- **Backend**: Tauri v2 (Rust)
- **Frontend**: React 19 + TypeScript
- **Editor**: Monaco Editor (the editor that powers VS Code)
- **Bundler**: Vite
- **Styling**: vanilla CSS
