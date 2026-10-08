# Changelog

All notable changes to ZITEXT Editor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Find works inside the Markdown preview. (#92)
- On Windows and Linux, the in-app menu bar has the editing commands (Undo, Redo, Cut, Copy, Paste, Select All, Toggle Line Comment) and full screen (**F11**). (#92)
- A **System** theme that follows the operating system's light or dark setting. (#104)
- New fonts: Space Grotesk (the new interface default), Geist, IBM Plex Sans and IBM Plex Mono. (#104)
- ZITEXT remembers the window's size and position (and whether it was maximized) between launches. A saved position that is no longer on any screen is ignored.
- The Explorer and **Find in Files** say how many symbolic links they left out. Links are still not followed, since they can point outside the open folder.
- **Large File and Log viewer** (**File → Open Large File or Log…**, or offered when a file is over the editor's 10 MB limit). Opens files of any size read-only, reading only the part on screen. Follows a log as it grows (**Live**, **Follow**, **Latest**) and notices when it is rotated, truncated or deleted. Filters lines in or out by text or regular expression, combined with AND or OR, without changing the file. Highlights errors, warnings, info and debug lines, HTTP status codes, request IDs and your own keywords. **Go to** takes a line number, a percentage or a time; **Find** searches the whole file; lines can be bookmarked. Filtered, highlighted, selected or bookmarked lines can be exported to a new file, byte for byte.
- **File Compare** (**File → Compare**, or the command palette): compare the current document with another file, another open tab, the clipboard, or its saved version on disk. Side by side or inline, with added, removed and changed lines and the changed characters marked. Step through changes (first, previous, next, last; **Alt+F5**), copy a change to either side, and ignore leading/trailing whitespace, all whitespace, case or blank lines. Edits made in the comparison are ordinary edits to the document (undo, autosave, Save).
- **Text and Data Tools** (**Tools** menu and the command palette): sort lines A–Z, Z–A or by number; remove duplicate, empty or repeated blank lines; trim, reverse, join and split lines; count unique lines; upper, lower and title case; URL, Base64, HTML and JSON encoding and decoding; JWT decoding (on your computer, signature not checked); UUIDs; SHA-256 and MD5 checksums; Unix timestamp ↔ date; CSV, TSV and JSON conversions (values kept exactly as text) and XML minification. They act on the selection, or on the whole document, as one undo step, and never change a read-only document.
- **Marks** (**Tools → Mark Selection**, **Cmd/Ctrl+Shift+M**, or **Mark** in the Find bar): keep every occurrence of text or a regular expression highlighted, in up to six colours, while you edit; **F4** / **Shift+F4** go to the next or previous one, and marks are cleared one at a time or all at once.
- **Scratchpad** (**Tools → Open Scratchpad**, **Cmd/Ctrl+Shift+N**): a note with no file name and no Save dialog. It saves itself as you type (in ZITEXT's private data folder) and is there again on the next launch, including after quitting with **Don't Save**.

### Changed
- Redesigned interface: new colours and typography, language badges in the Language menu and status bar, and on Windows the app draws its own window controls. (#104)
- The macOS minimum system version is now 10.15, the oldest version the app framework supports.
- The README describes crash recovery accurately (a normal quit starts fresh), how to install the command-line wrapper, when column selection is available, and the Node.js version the project needs (22.22.2 or later 22.x). SECURITY.md no longer claims the content security policy is off during development.

### Fixed
- **Revert File** no longer overwrites a newer version of the file changed by another program without asking. It checks the file's on-disk version first and asks before replacing an external change, and it now waits for any save already in progress.
- **Reload** no longer discards edits typed while the file was being read; the reload is cancelled with a notice instead.
- **Autosave** never opens a dialog. If the file changed on disk, or its text can't be stored in the file's encoding, autosave pauses for that file and shows a notice; a manual save, Reload or Revert resumes it.
- A second Save after closing a tab (for example a double-click on **Save** in the unsaved-changes dialog) no longer opens a "Save As" dialog and writes an empty file.
- Unsaved edits recovered after a crash no longer overwrite changes made to the same file after the crash. The file is marked as changed on disk, and saving asks before overwriting.
- Opening ZITEXT with a file (double-click, **Open With**, or the command line) after a crash no longer discards the previous session's unsaved work. The session is restored and the opened file becomes the active tab.
- Answering the **Restore Previous Session** prompt late no longer loses recovered files: a late **Restore** still reopens them, and the stored recovery data is kept untouched until the prompt is answered, even if you quit first.
- Unsaved changes to a file that was deleted, moved or became unreadable before recovery now reopen in a **Recovered** tab instead of being lost.
- One unavailable file or an oversized document no longer disables crash recovery for every tab. Recovery keeps everything that fits, and tells you once if a document is too large to keep a copy of; recovery failures are now reported instead of being silent.
- Untitled documents containing only whitespace are now kept by crash recovery.
- Switching a split-view pane to a Markdown preview tab and back no longer crashes the editor into the error screen, and toggling preview or split view no longer loses a document's undo history.
- A problem inside one editor pane now shows an error in that pane only, with a **Reopen editor** button; open documents and unsaved changes are unaffected. If the whole app does hit the error screen, the window can still be closed, and the last crash-recovery snapshot is kept for the next launch.
- **Find & Replace** keeps its matches up to date as the document changes, so **Replace** always edits the text that is actually matched (it could previously change unrelated text after an edit). Replace now acts on the selected match, or selects the next one first.
- Regular-expression replacements now expand `$1`–`$99`, `$&`, `$$`, `\n` and `\t`. **Replace All** is undone in one step, separately from what you typed before it.
- **Whole Word** no longer matches inside identifiers such as `user_id`, so Replace All can't corrupt them.
- Pressing **Enter** in the Replace field no longer skips every other match.
- Enter used to confirm input-method (IME) text no longer triggers Replace or a command palette entry.
- The command palette selects the first result whenever you type, so **Enter** no longer runs a different command than the top match.
- Keyboard shortcuts work on non-US layouts: AltGr characters such as `\` no longer toggle split view, and shortcuts like Ctrl+S work with Cyrillic, Greek and other layouts. **Alt+Z** (word wrap) now works on macOS, and shortcuts you record with Option (macOS) or on a non-Latin layout now work.
- **Copy**, **Cut** and **Paste** work with multiple cursors and selections, and copy or cut the whole line when nothing is selected, as Monaco's built-in commands do. Pasting several lines with the same number of cursors puts one line at each cursor.
- **Cut** and **Paste** no longer edit a different document or selection if you switch tabs or keep typing while the clipboard is being accessed. Cut never removes text that didn't reach the clipboard, and neither changes a read-only document.
- The JSON, XML and YAML tools in the command palette no longer change **read-only** documents, use your **Tab Size** setting, and keep the file's line endings (CRLF stays CRLF) and final newline.
- **Format YAML** no longer changes values: numbers such as `0755`, `0x1F`, `1e3` and very large integers are kept exactly as written, and long lines are no longer folded. If a document can't be formatted without changing a value, it is left unchanged.
- A settings file damaged so badly that it isn't valid text no longer stops settings, recent files and crash recovery from being saved; it is set aside like any other damaged settings file. Only the three newest damaged-settings backups are kept.
- Temporary files left next to a document by an interrupted save are cleaned up.
- **Format on Save** skips read-only documents and now also formats XML and YAML files; its description in Settings lists the supported file types.
- Files that start with a UTF-8 byte-order mark (BOM) keep it when saved; the status bar shows **UTF-8 with BOM**. A file with a BOM and one invalid byte now opens as Windows-1252 and saves back byte for byte (every save used to fail).
- UTF-16 files are no longer reported as binary; ZITEXT explains that they need converting to UTF-8 first, instead of silently converting them on the next save.
- A Windows-1252 file under the 10 MB limit can be saved even when its text would be larger than 10 MB in UTF-8.
- Saving a **read-only** file now asks first (**Save Anyway**); the file stays read-only afterwards, and ZITEXT doesn't ask again for that file. Autosave never changes a read-only file you haven't confirmed; it pauses for that tab and says why. Files you can't write to (owned by another user, or locked in Finder) count as read-only too.
- A writable file in a folder that doesn't allow new files (some shared folders) can now be saved; it is written in place.
- Saving a file with several hard links updates all of them, and on macOS a save keeps the file's extended attributes (such as Finder tags) and access-control list.
- On Windows, a save that collides with another program briefly holding the file (log viewers, antivirus) is retried instead of failing.
- Network folders (`\\server\share`) on Windows now show their files in the explorer, and files from them open from search, recent files and crash recovery.
- Renaming a file to change only its letter case (`readme.md` → `README.md`) now works, and renaming works on drives that don't support hard links (FAT, exFAT and many network shares). Renaming still never replaces an existing file.
- A slow or unreachable network folder, a long **Find in Files** search or file counting no longer delays saving other files.
- Renaming a file that was opened on its own (not from an open folder) now works: ZITEXT asks you to confirm the new name instead of failing.
- Renaming a tab to its current name no longer shows an error, and invalid names (empty, containing `/` or `\`, or reserved on Windows) are explained before anything changes. A rename made while a save is still running no longer reverts to the old name.
- `zitext --wait` now returns when you close the document after renaming it or using **Save As**, instead of waiting until ZITEXT quits.
- **Save As** onto a file that is already open in another tab is refused (that tab is shown), so two tabs can no longer edit the same file.
- Opening a file through a different path (a symbolic link, different letter case, a relative path from the command line, or two quick opens at startup) now switches to its existing tab instead of opening a second copy.
- Closing one of two tabs that showed the same file no longer stopped change detection for the other.
- Saving an untitled document suggests a name with the extension of its language (for example `Untitled-1.py`), names such as `Untitled-1.txt` are accepted, and the document keeps its language when the chosen name has no extension. Saving an existing file no longer resets a language mode you picked.
- Native Open, Save and Open Folder dialogs no longer stop working after being open for five minutes.
- macOS: the **ZITEXT** menu now has About, Services, Hide (**Cmd+H**), Hide Others, Show All and **Quit (Cmd+Q)**, and a **Window** menu adds Minimize (**Cmd+M**), Zoom and the list of open windows. Quit asks about unsaved changes like closing the window. Because Cmd+H now hides the app, **Find & Replace** on macOS moved to **Cmd+Option+F** (Ctrl+H elsewhere is unchanged).
- Crash recovery keeps a copy of your edits about two seconds after you stop typing (at least every 10 seconds while you type), instead of every 30 seconds, so quitting from the Dock, logging out or shutting down loses far less.
- Files and folders handed to ZITEXT while it starts (command line, **Open With**, several files at once on Windows, a second launch) are no longer dropped, and the folder from `zitext .` opens reliably. If a file passed to `zitext --wait` can't be opened, the command returns instead of waiting until ZITEXT quits.
- `zitext file.txt` and `zitext .` work with relative paths on macOS (they were resolved against the root of the disk, and `zitext .` opened the whole disk as the project).
- `zitext --wait` on Linux no longer fails after 30 seconds when ZITEXT was started with a different temporary directory.
- If ZITEXT stops responding, closing it a second time offers **Quit Anyway** instead of a window that can't be closed. The error screen has a **Close ZITEXT** button (Windows has no other window controls there).
- Windows: the window opens at its intended size with the title **ZITEXT Editor** (it opened at 800×600 titled "Tauri App").
- The Language menus offer only modes that actually highlight, and there are more of them: 87 in all, adding Terraform (HCL), Protocol Buffers, MDX, reStructuredText, MySQL, PostgreSQL, Visual Basic, Tcl, SystemVerilog, WGSL, Bicep, Liquid, FreeMarker and others. **TOML** and **Makefile** now have syntax highlighting, **Solidity** highlights again, and Sass, LaTeX, Groovy, Haskell, Fortran, OCaml and VHDL (which never highlighted) were removed. The menus, status bar, command palette and file detection now share one list, so the status bar names every mode correctly (for example Dart).
- More file types open in the right mode, including `.mjs`, `.cjs`, `.mts`, `.cts`, `.kts`, `.pm`, `.psm1`, `.psd1`, `.dart`, `Dockerfile` and `Makefile`.
- Clicking the language in the status bar opens **Change Language Mode** in the command palette, which now lists every language.
- Automatic language detection for new documents is much faster on large pastes, recognises TypeScript, Java, Go, Kotlin, Swift, XML/SVG and Markdown correctly (they were often called Python or HTML), and never overrides a language you picked.
- `tsconfig.json`, `.vscode/*.json`, `*.jsonc` and similar files may contain comments and trailing commas without errors, and **Format JSON** keeps their comments.
- **Find in Files** opens a result at its line (it could open the file scrolled to the top), keeps its results when you open one or switch to the Explorer, and says when a search could not cover everything: stopped early, too many results, or files and folders it skipped. It now also searches Windows-1252 files, highlights matches correctly after characters such as `İ`, notes that unsaved changes are not searched, and clears results when you open another folder.
- The Explorer's filter finds files anywhere in the folder, including folders you have not expanded. Switching folders quickly no longer shows the previous folder's files, and a folder with more than 5,000 items shows the first 5,000 with a note instead of failing.
- The Explorer's × now hides the sidebar; **Close Folder** is a separate button, and the tree keeps its expanded folders when you switch to Find in Files and back.
- **Go to Line** accepts `line:column` (for example `120:8`).
- **Find** works in a Markdown preview shown in a split pane; clicking a pane makes it the one Find searches.
- The **changed on disk** banner stays until the change is dealt with: cancelling a reload, or a reload or save that fails, no longer hides it. A successful save removes it.
- Saving no longer occasionally reports your own save as an external change.
- If the folder containing an open file is deleted or renamed, the tab now shows that the file was removed (it used to go quiet), and saving explains that the folder is gone instead of reporting an access error.
- Files that mix line-ending styles (or use old Mac CR-only line breaks) show **Mixed** in the status bar, and ZITEXT says when opening them that editing will convert their line endings. Find in Files line numbers now match the editor for such files.
- Crash-recovery data is kept in its own file and only rewritten when it changes, so opening and saving files no longer rewrites it each time (up to 32 MB). Existing recovery data is carried over.
- If ZITEXT can't save its settings or recent files (for example, the disk is full), it now tells you, and a setting that failed to save is no longer written later by accident.
- **Escape** now closes every dialog, including Keyboard Shortcuts, About, Diagnostics and the unsaved-changes prompt when quitting.
- The update prompt no longer hides a version for good when you choose **Remind me later**, **Download** or close it; only **Skip this version** does. It no longer puts focus on a button when it appears, so a stray Enter can't act on it. An update from a pre-release (for example 2.2.0-rc.1) to its release is now offered.
- The autosave delay in Settings can be typed normally (typing 1500 used to give 10000); the value is checked when you leave the field.
- With the same file in both split panes, each pane keeps its own cursor and scroll position.
- Shortcut hints match your platform (New File showed Cmd+N on Windows and Linux; Format Document shows Ctrl+Shift+I on Linux), and **Ctrl+Shift+=** and the keypad **+** zoom in.
- **Copy File Path** and **Copy Diagnostics** use the system clipboard reliably, and Diagnostics no longer counts the session you are in as a crash.
- The split-view divider can be moved with the keyboard (arrow keys, Home and End), and close buttons that show only an icon or × have accessible names.
- Settings, Keyboard Shortcuts and Diagnostics load when first opened, which keeps startup lighter.
- **Format on Save** no longer reformats a new document before its Save As dialog (cancelling the dialog left it reformatted but unsaved).
- A network folder that stops answering no longer ties up the app: a file there no longer holds up change detection for your other files, and starting a new Find in Files search, typing in the Explorer filter or opening another folder stops the search or file count still running.
- The Keyboard Shortcuts editor refuses keys already used by fixed commands (such as Find in Files, Split View, Undo or Copy) instead of letting both act. On macOS it notes that the menu bar keeps its original keys.
- Moving the cursor in a large file no longer recounts the whole document's lines on every move.
- Pressing Save while a **Reload** is still reading the file no longer writes the old text back over the reloaded version.
- A file opened while ZITEXT is starting up stays the active tab, and no empty Untitled tab is added next to it.
- A folder dropped on the Dock icon, or opened with `open -a "ZITEXT Editor" folder`, opens as the project folder.
- Clicking the status-bar language now lets you type to narrow the list (for example "py").
- **Format XML** keeps entity and character references as written (`&quot;`, `&#169;` …) and puts comments before the root element on their own line.
- Custom keyboard shortcuts now apply everywhere: on macOS the menu bar shows them and responds to them, and every part of the app reads them from one list.
- Moving the cursor or scrolling no longer redraws the whole window on every move, and the Explorer tree no longer redraws while you type.
- A regular expression in **Find** that would take too long on the document is no longer run (the search shows **Too slow**), instead of freezing the window.
- **Format JSON**, **Minify JSON**, **Sort JSON Keys**, **Format YAML** and Format on Save for YAML run in the background, so large documents don't freeze the window; if you edit the document meanwhile, the result is not applied.
- With the Markdown preview open beside the editor, the preview updates when you pause typing instead of on every keystroke.
- ZITEXT starts with less to load: the Markdown preview loads the first time a document is previewed.
- **Toggle Markdown Preview** is only available for Markdown (and MDX) files; it used to render any file as Markdown.
- **Open Recent** no longer lists files that have since been deleted or moved.
- The window title names a new document as its tab does ("Untitled-3"), and follows whichever split-view pane has focus.
- The status bar shows the file's size in bytes as saved (UTF-8, UTF-8 with BOM or Windows-1252). It showed the number of characters, which is smaller for accented letters and emoji.
- The **Font size** setting goes up to 72, as zoom does (it stopped at 32).
- A shortcut recorded with the **+** key is stored as `Plus` and works; it used to be saved in a form that never fired.
- The file name in the breadcrumb no longer looks clickable (it did nothing).
- Checking open files for outside changes pauses while the window is minimized or hidden, and runs as soon as it is visible again.
- `tauri dev` on macOS no longer quits at launch while the installed ZITEXT is running.
- If the window failed before it could reopen the files of a late **Restore**, crash recovery kept working for the rest of the session; the files not yet reopened stay in the recovery data. Before, recovery stopped saving until the next launch.
- The Explorer's file count shows **100,000+ files** (with an explanation) when counting stopped at a limit, instead of presenting the partial figure as exact.
- A damaged crash-recovery file is set aside as `session.corrupt.….json` rather than under a settings-file name, and no longer counts against the three kept settings backups.
- Linux: ZITEXT starts without a D-Bus session bus (some minimal desktops and remote sessions); a second launch then opens a separate window instead of handing its files over.

### Security
- Links in the **Markdown preview** can no longer navigate the editor window. Web and email links open outside ZITEXT after a confirmation showing the full address, links to headings scroll the preview, and relative links open the file as a tab. Previously a relative link reloaded the app (losing unsaved work) and a web link loaded the site inside the editor window.
- The editor window refuses to navigate anywhere other than the app itself.
- **F5**, **Ctrl+R** and the browser Back/Forward keys no longer reload or navigate the app on Windows.
- Markdown documents can no longer use the editor's own class names, ids or data attributes, which let a document draw a fake app dialog and block keyboard shortcuts.
- Opening a JSON file no longer makes the editor request the URL in its `$schema` field.
- ZITEXT's own settings, crash-recovery data, crash logs and corrupt-settings backups are now readable only by your user account on macOS and Linux (they were created readable by other local users). Existing files are tightened automatically.
- The Save As dialog only accepts a plain file name as its suggestion from the editor window, so it can't be pointed at another folder.
- Links that contain a user name or password, and email links with fields other than to, cc, bcc, subject and body, are no longer opened. The confirmation names the website or recipient on a line of its own, so a long link can't hide it.
- macOS: the channel a second launch uses to hand files to the running ZITEXT now lives in your own private folder, and both sides check that the other belongs to the same user. Before, another account on the same Mac could intercept the file paths you opened from the command line, or stop ZITEXT from opening them.

- Closing the project folder, or opening a different one, ends ZITEXT's access to it. Files still open from that folder stay editable.
- The Markdown preview's link handling is the only code that opens links: the link-opening helper the opener plugin adds to every page is turned off, and links are opened by their parsed address. Unused `asset:` entries were removed from the content security policy.
- A crash-recovery snapshot written while the app is closing can no longer bring back a session you chose to discard.

### Dependencies
- Updated `source-map-js` to 1.2.2 (GHSA-68fv-2mgg-jv7q, a build-time tool) and `event-listener` to 5.4.2 (RUSTSEC-2026-0221), and replaced the yanked `chacha20 0.10.1` with 0.10.2.

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
