# Security Policy

## Overview

ZITEXT Editor implements multiple security layers to protect users from common web-based attacks while maintaining full functionality of the text editor.

## Content Security Policy (CSP)

### Implementation

A strict Content Security Policy is enforced in production builds via the Tauri configuration file at `src-tauri/tauri.conf.json`.

**Current CSP:**
```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: asset: https://asset.localhost;
font-src 'self' data:;
worker-src 'self' blob:;
connect-src 'self' ipc: https://ipc.localhost https://zitext.com;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

### Directive Explanations

#### `default-src 'self'`
**Purpose:** Establishes a restrictive baseline - all resource types default to loading only from the application's origin.

**Protection:** Prevents loading of unauthorized resources from external domains.

#### `script-src 'self' 'wasm-unsafe-eval'`
**Purpose:**
- `'self'` - Only execute JavaScript from the application bundle
- `'wasm-unsafe-eval'` - Allow WebAssembly compilation (required by Monaco Editor)

**Trade-offs:**
- ✅ Blocks inline scripts and `eval()`
- ⚠️ Permits WebAssembly (necessary for Monaco's performance features)

**Protection:** Prevents execution of injected malicious scripts.

#### `style-src 'self' 'unsafe-inline'`
**Purpose:**
- `'self'` - Load stylesheets from application
- `'unsafe-inline'` - Allow inline styles (Monaco Editor requirement)

**Trade-offs:**
- ✅ No external stylesheets allowed
- ⚠️ Inline styles permitted (Monaco dynamically generates styles for syntax highlighting)

**Why needed:** Monaco Editor creates inline `<style>` tags for theme colors, syntax highlighting, and editor decorations.

#### `img-src 'self' data: blob: asset: https://asset.localhost`
**Purpose:**
- `'self'` - Images from application
- `data:` - Data URI images (base64 encoded)
- `blob:` - Blob URLs (dynamically generated images)
- `asset:` / `https://asset.localhost` - Tauri asset protocol

**Use cases:** Icons, user-provided images in files, generated graphics.

#### `font-src 'self' data:`
**Purpose:** Load fonts from application bundle or data URIs.

**Protection:** Prevents external font loading that could be used for tracking.

#### `worker-src 'self' blob:`
**Purpose:**
- `'self'` - Web Workers from application
- `blob:` - Dynamically created workers (Monaco Editor)

**Why needed:** Monaco Editor creates Web Workers for:
- Syntax highlighting in background threads
- TypeScript language service
- JSON/CSS/HTML language features

#### `connect-src 'self' ipc: https://ipc.localhost https://zitext.com`
**Purpose:**
- `'self'` - Allow fetch/XHR to same origin
- `ipc:` / `https://ipc.localhost` - Tauri IPC protocol
- `https://zitext.com` - the optional update-availability check (fetches the latest version number only)

**Why needed:** Frontend-backend communication via Tauri's IPC system, plus the optional update check. Fonts are self-hosted (see `public/fonts.css`), so no external font/style hosts are needed.

#### `object-src 'none'`
**Purpose:** Block all plugins (Flash, Java, ActiveX, etc.)

**Protection:** Eliminates entire class of plugin-based vulnerabilities.

#### `base-uri 'self'`
**Purpose:** Restrict `<base>` tag to application origin.

**Protection:** Prevents attackers from changing the base URL to redirect relative links.

#### `form-action 'self'`
**Purpose:** Restrict form submissions to application origin.

**Protection:** Prevents forms from submitting data to malicious domains.

#### `frame-ancestors 'none'`
**Purpose:** Prevent ZITEXT from being embedded in `<iframe>`, `<frame>`, or `<object>` tags.

**Protection:** Defends against clickjacking attacks.

---

## Backend Security (Rust/Tauri)

### Path Traversal Protection

**Implementation:** `src-tauri/src/lib.rs` (`validate_path`)

All file operations canonicalize paths (resolving symlinks and `..` segments) before opening. Non-existent paths used for save targets are normalized component-by-component and reject any `..` that would escape the path root.

```rust
// Blocked: virtual / pseudo-filesystems that cannot be meaningfully
// read as text and can hang or return garbage:
- Unix: /proc, /sys, /dev

// Allowed (intentional, editor use case):
- Unix: /etc, /root, /boot, and all other real filesystem paths
- Windows: System32, Windows, Program Files, and all real paths
```

**Protection scope:** This prevents path-traversal escape from canonicalized paths and blocks reads that would hang on kernel pseudo-filesystems. It does **not** sandbox the editor away from user-readable files — that is the file-authority model documented below.

### File Authority Model

The renderer is treated as untrusted. Every command that touches a user-supplied filesystem path (`read_file_content`, `write_file_content`, `rename_file`, `read_directory`, `get_file_metadata`, `get_files_metadata`, `search_in_files`) checks an in-memory path-grant registry before doing any I/O.

**Grants are issued at these entry points (each tied to a current user action, or to a path the user opened in a prior session):**

| Entry point | Grant type |
|---|---|
| File → Open via native menu / `Cmd+O` | Single-file grant for the picked path |
| File → Open Folder via native menu | **Recursive** grant — covers the folder and all descendants |
| File → Save As via native menu / `Cmd+Shift+S` | Single-file grant for the picked target |
| File → Recent Files (macOS native menu) item click | Single-file grant for the chosen entry |
| In-app Recent Files list / Welcome screen click → `grant_recent_path` | Single-file grant — issued **only** if the path is already in the persisted `recent_files` list |
| OS drag-and-drop onto the window | Single-file (or recursive folder) grant for the dropped path, issued in Rust from the native drop event |
| Session-restore prompt at launch (Restore button) | Single-file grants for every file in the last session |
| Previously-opened folder, restored at startup | **Recursive** grant, read from the trusted settings file so the explorer can reopen the last workspace |
| `zitext <file>` CLI arg (startup or running) | Single-file grant |
| `zitext <folder>` CLI arg | Recursive folder grant |
| macOS Finder "Open With ZITEXT" / file association | Single-file grant |
| In-app "Open" / "Open Folder" / "Save As" toolbar buttons → `request_menu_action` | Same as the corresponding menu item |
| `rename_file` succeeds | Grant moves from old path to new path |

**Dialog access is funneled.** The Rust commands that show file/folder/save dialogs (`show_open_file_dialog`, `show_save_file_dialog`, `show_open_folder_dialog`) are *not* `#[tauri::command]` — they cannot be invoked from the renderer. The only renderer-callable dialog entry is `request_menu_action`, which accepts an allowlist of `"open"`, `"open_folder"`, `"save_as"` and routes through the same Rust dialog flow that native menu clicks use. Dialog results are emitted as events (`open-from-dialog`, `folder-from-dialog`, `save-from-dialog`, plus the canonical `open-file` / `open-folder` for the menu path) — the renderer never directly receives a path from an invoke return.

**Session restore is gated by a native prompt.** On launch, if the last session contained file-backed tabs, a native modal asks "Restore N files from your last session?". On *Restore*, the backend grants every path and the renderer's `getLastSession` returns the full list (with cursor/scroll metadata). On *Skip*, the backend filters file-backed entries out of the returned list; only untitled-tab restoration proceeds.

**Clipboard trade-off.** Clipboard read/write permission is exposed to the main
window because Monaco's webview paste path is unreliable on some Windows
WebView2 versions and the editor's explicit Copy/Cut/Paste actions use the
native clipboard plugin. A renderer compromise could therefore read or replace
clipboard text while the application is running. File, shell, HTTP, and general
URL-opening permissions remain unavailable; deployments that prioritize
clipboard confidentiality over native paste behavior should remove these two
capabilities.

**Writes are conflict-safe.** Disk-backed tabs carry a backend-generated
mtime/size/SHA-256 snapshot. The backend serializes writes, verifies that exact
snapshot immediately before saving, writes through a same-directory temporary
file, flushes it, atomically publishes it, and refuses to overwrite an external
change. Windows-1252 documents retain their original encoding unless the user
chooses a different format.

**Session data is redacted from the renderer-facing settings read.** `read_settings` (renderer-callable) returns settings with `last_session` stripped, so a compromised renderer cannot read previous-session file paths or preserved unsaved-buffer content before the user consents. `get_last_session` is the only command that returns session data, and it blocks until the restore-prompt decision. The renderer *can* re-grant a path that is already in the persisted `recent_files` list (via `grant_recent_path`, used by the in-app Recent Files list and Welcome screen), but it cannot grant an arbitrary path.

**Out-of-scope paths (no grant needed):**
- App config directory (settings, recent files, crash log) — managed by `read_settings`, `write_settings`, `save_session`, `add_recent_file`, `append_crash_log`. The renderer cannot pass arbitrary paths to these commands.
- The `--wait` lock files in the system temp dir — created and cleaned up by the backend, never written based on a renderer-supplied path.

**What this protects against:**
- A renderer compromise cannot read `~/.ssh/`, `~/.aws/credentials`, browser session stores, etc. The reachable set is bounded to: files the user actively opened in this session via a native gesture, files the user chose to restore at launch, files already in the persisted recent-files list (grantable via `grant_recent_path`), and the previously-opened workspace folder (recursively granted at startup). All of these are paths the user opened by a deliberate action in this or a prior session.
- A compromised renderer cannot programmatically open a file dialog with an `invoke` call to a primitive command — those commands don't exist. The narrow `request_menu_action` allowlist (three action strings, no path argument) is the only invokable surface.
- A compromised renderer cannot grant an *arbitrary* path: `grant_recent_path` only grants paths already present in the persisted `recent_files` list, and `last_session` is redacted from `read_settings` (session data is available only via the consent-gated `get_last_session`).
- **Accepted convenience (documented trade-off):** the previously-opened folder is recursively re-granted at startup without a fresh user gesture, so the file explorer can restore the last workspace. This widens the post-compromise reachable set to that one folder tree (the folder the user opened in the prior session). Gating it behind a per-launch confirmation is the stricter alternative if this trade-off is unacceptable for a deployment.

**What this does NOT protect against:**
- An attacker who can drive the OS file dialog (e.g. via Accessibility / Apple Events / UI Automation) after triggering `request_menu_action` can still cause the user to grant arbitrary paths. Defense here relies on the user being physically present at the picker. OS-level sandboxing (macOS App Sandbox + PowerBox; Windows AppContainer) is the only kernel-enforced answer and is tracked as a longer-term project.
- A persistent supply-chain compromise of a frontend dependency could continually call `request_menu_action` to harass the user with picker dialogs, but cannot bypass the picker itself.

### File Size Limits

**Maximum file size:** 10 MB per file

**Purpose:**
- Prevent memory exhaustion attacks
- Ensure application remains responsive
- Protect against accidental large file loads

### Directory Traversal Limits

**Maximum directory depth:** 10 levels
**Maximum entries per directory:** 5,000 files

**Purpose:**
- Prevent infinite recursion (symlink loops)
- Prevent memory exhaustion from deeply nested directories
- Ensure file explorer remains performant

### Encoding Detection

**Supported encodings:** UTF-8, Windows-1252 (fallback)

**Security benefit:** Prevents encoding-based injection attacks where malicious content is disguised using unexpected character encodings.

### Operation Timeouts

**Dialog timeout:** 5 minutes

**Purpose:** Prevent hanging operations that could lead to denial-of-service or UI freezing.

---

## Frontend Security (React/TypeScript)

### HTML Injection Defenses

The codebase avoids:
- ❌ `innerHTML` - No DOM manipulation with strings
- ❌ `eval()` - No dynamic code evaluation
- ❌ Inline event handlers in HTML - All handlers via React

`dangerouslySetInnerHTML` is used in one place — `src/components/MarkdownPreview.tsx` — to render Markdown. The output of `marked.parse()` is passed through DOMPurify with a strict allowlist:

- No `<style>`, `<svg>`, `<math>` elements
- No inline `style=` attributes
- No `javascript:` URLs (DOMPurify default protocol allowlist)
- Only standard prose tags (headings, paragraphs, lists, code, tables, links, images)

**Verification:** `grep -rn 'dangerouslySetInnerHTML' src/` should return exactly one hit in `MarkdownPreview.tsx`, on a value that originated from `DOMPurify.sanitize(...)`. `grep -rn '\binnerHTML\b\|\beval\b' src/` should return no application matches.

### TypeScript Strict Mode

```json
{
  "strict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true
}
```

**Benefits:**
- Type safety prevents common bugs
- Null/undefined checks enforced
- No implicit `any` types

### Error Boundaries

**Implementation:** `src/components/ErrorBoundary.tsx`

**Purpose:** Gracefully handle React errors without exposing stack traces to users.

---

## Testing CSP Compliance

### Development Testing

During development, CSP is **disabled** (`"csp": null` in dev) for:
- Hot module replacement (HMR)
- Development tools
- Faster iteration

### Production Testing

To test CSP in production mode:

```bash
# Build the production app
npm run tauri build

# Run the built application
# macOS: open src-tauri/target/release/bundle/macos/ZITEXT.app
# Windows: src-tauri/target/release/bundle/msi/ZITEXT.msi
# Linux: src-tauri/target/release/ZITEXT
```

**What to test:**
1. ✅ File operations (open, save, save as)
2. ✅ Syntax highlighting works
3. ✅ Monaco editor loads correctly
4. ✅ Theme switching works
5. ✅ Settings persistence works
6. ✅ File explorer functions
7. ✅ No console CSP violation errors

### Browser DevTools

If CSP violations occur, they appear in the console as:

```
Refused to execute inline script because it violates the following
Content Security Policy directive: "script-src 'self'"
```

**Troubleshooting:** Check browser console for CSP errors and adjust policy if legitimate functionality is blocked.

---

## Modifying the CSP

### When to Modify

Only modify CSP if:
1. Adding a new feature that requires additional permissions
2. Integrating a third-party service (consider security implications)
3. Fixing a legitimate CSP violation

### How to Modify

1. Edit `src-tauri/tauri.conf.json`
2. Locate the `"security"` section
3. Update the `"csp"` string
4. Test thoroughly in production build

### Testing Changes

```bash
# After modifying CSP
npm run tauri build
# Test all features in the built app
```

### Guidelines

- ⚠️ **Never use `'unsafe-eval'`** unless absolutely necessary
- ⚠️ Avoid `'unsafe-inline'` for scripts (styles are acceptable for Monaco)
- ✅ Always use `'self'` as the baseline
- ✅ Be as restrictive as possible while maintaining functionality
- ✅ Document the reason for any permissive directive

---

## Additional Security Measures

### Input Validation

- All file paths validated before operations
- File extensions checked for language detection
- Size checks before reading files

### Settings Validation

- Settings JSON schema validated
- Invalid settings fall back to defaults
- No executable code stored in settings

### Dependency Security

**Regular updates recommended:**
```bash
# Check for vulnerable dependencies
npm audit

# Update dependencies
npm update
```

**Critical dependencies monitored:**
- `@tauri-apps/*` - Desktop framework security
- `react` - UI framework security
- `@monaco-editor/react` - Editor security

---

## Reporting a Vulnerability

Please report security vulnerabilities privately — **do not open a public issue.**

Use GitHub's **Security → Report a vulnerability** to open a private security
advisory for this repository. Please include:

- a description of the vulnerability,
- steps to reproduce,
- the potential impact, and
- a suggested fix, if you have one.

We aim to acknowledge reports promptly and will coordinate a fix and a
disclosure timeline with you.

---

## Security Best Practices for Contributors

### Code Reviews

All code changes should be reviewed for:
- CSP compliance
- Input validation
- Path traversal risks
- XSS vulnerabilities
- Injection attacks

### Adding Dependencies

Before adding new npm/cargo dependencies:
1. Check package reputation and downloads
2. Review package security history
3. Audit for known vulnerabilities
4. Consider bundle size impact

### Testing

Security-related changes must include:
- Unit tests for validation logic
- Integration tests for file operations
- Manual testing of CSP compliance

---

## Compliance

ZITEXT's security implementation aligns with:

- **OWASP Top 10** - Protections against common web vulnerabilities
- **CWE-79** - Cross-Site Scripting (XSS) prevention via CSP
- **CWE-22** - Path Traversal prevention
- **CWE-434** - Unrestricted file upload protection (size limits)

---

For a history of changes, see [CHANGELOG.md](CHANGELOG.md).
