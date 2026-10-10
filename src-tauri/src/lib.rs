use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// Debug-only logging. In release builds (`debug_assertions` off) the body is
/// compiled out entirely, so file paths, sizes, and authorization decisions are
/// never written to stdout in shipped binaries and there is zero runtime cost.
macro_rules! dlog {
    ($($arg:tt)*) => {
        #[cfg(debug_assertions)]
        {
            println!($($arg)*);
        }
    };
}

// macOS-only replacement for tauri-plugin-single-instance:
// the plugin's socket is a fixed path in world-writable /tmp.
#[cfg(target_os = "macos")]
mod macos_single_instance;

// The large file and log viewer: indexes, reads, filters and exports files
// too big for the editor, without loading them whole.
mod large_file;

// Lazy static for dialog state management
use std::sync::OnceLock;

static SAVE_DIALOG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static OPEN_DIALOG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static FOLDER_DIALOG_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static DIALOG_REQUEST_IN_FLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static FILE_WRITE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static FS_OPERATION_LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
static STARTUP_ARGS: OnceLock<std::sync::Mutex<Vec<String>>> = OnceLock::new();
static STARTUP_FOLDER: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
/// Tracks whether the frontend has already consumed startup args.
static STARTUP_ARGS_CONSUMED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
/// Maps file path → CLI-created lock files for --wait mode.
/// When the tab is closed, every corresponding lock is deleted.
static WAIT_LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();

/// Session-restore decision signal. Set only by the native dialog callback,
/// or immediately if there is no file-backed session to restore.
/// `get_last_session` waits on this before returning, so the renderer's
/// session-restore code does not race the prompt.
/// State: 0 = pending, 1 = restore, 2 = skip.
static SESSION_DECISION: OnceLock<std::sync::atomic::AtomicI8> = OnceLock::new();
static SESSION_DECISION_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();

fn session_decision_atomic() -> &'static std::sync::atomic::AtomicI8 {
    SESSION_DECISION.get_or_init(|| std::sync::atomic::AtomicI8::new(0))
}
fn session_decision_notify() -> &'static tokio::sync::Notify {
    SESSION_DECISION_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

fn set_session_decision(restore: bool) {
    let next = if restore { 1 } else { 2 };
    if session_decision_atomic()
        .compare_exchange(
            0,
            next,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_ok()
    {
        session_decision_notify().notify_waiters();
    }
}

/// Set when `get_last_session` stopped waiting for the restore prompt before
/// the user answered. Until the renderer has fetched the session again (after
/// a late "Restore") or the user chose Skip, snapshots must not replace the
/// stored session, or its file-backed recovery entries would be lost.
static SESSION_LATE_RESTORE_PENDING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// True while the stored session must be preserved untouched: the restore
/// prompt is unanswered, or a late answer has not been consumed yet.
fn session_snapshot_blocked() -> bool {
    session_decision_atomic().load(std::sync::atomic::Ordering::SeqCst) == 0
        || SESSION_LATE_RESTORE_PENDING.load(std::sync::atomic::Ordering::SeqCst)
}

async fn wait_session_decision() -> bool {
    loop {
        match session_decision_atomic().load(std::sync::atomic::Ordering::SeqCst) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        let notified = session_decision_notify().notified();
        // Re-check after subscribing to close the wakeup race
        match session_decision_atomic().load(std::sync::atomic::Ordering::SeqCst) {
            1 => return true,
            2 => return false,
            _ => {}
        }
        notified.await;
    }
}

// Security constants
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB
const LARGE_FILE_WARNING: u64 = 1024 * 1024; // 1MB - warn user
const MAX_DIRECTORY_DEPTH: usize = 10;
const MAX_DIRECTORY_ENTRIES: usize = 5000;
const MAX_SEARCH_FILES_VISITED: u32 = 50_000;
const MAX_SEARCH_DURATION: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_SEARCH_QUERY_BYTES: usize = 1024;
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_SEARCH_PREVIEW_BYTES: usize = 4096;
const MAX_SEARCH_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_METADATA_BATCH: usize = 512;
const MAX_SESSION_FILES: usize = 100;
const MAX_SESSION_CONTENT_BYTES: usize = MAX_FILE_SIZE as usize;
const MAX_SESSION_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_SETTINGS_BYTES: usize = 40 * 1024 * 1024;
const MAX_CRASH_LOG_LINE_BYTES: usize = 16 * 1024;

async fn fs_operation_permit() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    FS_OPERATION_LIMIT
        .get_or_init(|| tokio::sync::Semaphore::new(4))
        .acquire()
        .await
        .map_err(|_| "Filesystem operation limiter is unavailable".to_string())
}

/// One counter per kind of long walk (Find in Files, explorer file count,
/// explorer name filter). Starting a new walk bumps its counter; the walk
/// still running for an older request stops at its next check instead of
/// holding a filesystem permit.
static SEARCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static COUNT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static NAME_SEARCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A walk's claim on its counter; superseded once a newer walk claims it.
#[derive(Clone, Copy)]
struct Supersede {
    counter: &'static std::sync::atomic::AtomicU64,
    generation: u64,
}

impl Supersede {
    fn claim(counter: &'static std::sync::atomic::AtomicU64) -> Self {
        let generation = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        Self {
            counter,
            generation,
        }
    }

    fn superseded(&self) -> bool {
        self.counter.load(std::sync::atomic::Ordering::SeqCst) != self.generation
    }
}

/// Per-search budget: a worst-case query on a deep tree could otherwise read
/// tens of thousands of files. We cap files visited and total wall-clock time.
struct SearchBudget {
    /// None for walks that can't be superseded (tests).
    supersede: Option<Supersede>,
    files_visited: u32,
    response_bytes: usize,
    started_at: std::time::Instant,
    /// Set true when any limit fires so the caller can surface partial results.
    stopped: bool,
    /// Files skipped as too large or in an encoding search can't read.
    skipped_large: u32,
    skipped_encoding: u32,
    /// Folders not searched because they are nested too deeply.
    skipped_deep: u32,
    /// Symbolic links not followed.
    skipped_links: u32,
}

impl SearchBudget {
    fn new() -> Self {
        Self {
            supersede: None,
            files_visited: 0,
            response_bytes: 0,
            started_at: std::time::Instant::now(),
            stopped: false,
            skipped_large: 0,
            skipped_encoding: 0,
            skipped_deep: 0,
            skipped_links: 0,
        }
    }

    /// Returns true if the search should keep going.
    fn check(&mut self) -> bool {
        if self.stopped {
            return false;
        }
        if self.supersede.is_some_and(|claim| claim.superseded()) {
            self.stopped = true;
            return false;
        }
        if self.files_visited >= MAX_SEARCH_FILES_VISITED
            || self.response_bytes >= MAX_SEARCH_RESPONSE_BYTES
            || self.started_at.elapsed() >= MAX_SEARCH_DURATION
        {
            self.stopped = true;
            return false;
        }
        true
    }
}

// ============================================================================
// File Authority Model
// ============================================================================
//
// The renderer is treated as untrusted: a successful renderer compromise must
// only get access to files the user has explicitly opened or saved during the
// current session (plus paths from the persisted recent-files / last-session
// lists, which were explicitly opened in a prior session).
//
// Every fs-touching command runs `authorize_path` first. A path is authorized
// when one of these grants covers it:
//   - A file grant (exact canonical match), issued by:
//       open_file_dialog, save_file_dialog, CLI startup arg, single-instance
//       handoff, macOS RunEvent::Opened.
//   - A folder grant (recursive: canonical starts_with), issued by:
//       open_folder_dialog, CLI startup folder, and — at startup only — the
//       previously-opened folder read from the trusted settings file so the file
//       explorer can restore the user's workspace. This is the folder-equivalent
//       of the recent-files fallback; the renderer cannot choose which folder.
//   - A recent-files / last-session grant, issued by `grant_recent_path` for
//       paths the user previously opened (in-app Recent Files / Welcome screen),
//       plus the macOS native recent-files menu and OS drag-and-drop.
//
// Commands operating on the app's own config dir (read_settings, write_settings,
// save_session, get_last_session, get_recent_files, add_recent_file,
// append_crash_log) bypass this check — they never touch user-supplied paths.

#[derive(Debug, Clone)]
struct PathGrant {
    canonical: PathBuf,
    recursive: bool,
}

static FILE_GRANTS: OnceLock<std::sync::Mutex<Vec<PathGrant>>> = OnceLock::new();

/// Returns a canonical PathBuf suitable for grant comparison.
///
/// For an existing file/folder, this resolves symlinks via `canonicalize()`.
/// For a not-yet-created path (e.g. the target of a Save As), it canonicalizes
/// the parent and appends the basename — so the grant we record at dialog time
/// matches the path we'll check at write time.
fn canonical_form(path: &std::path::Path) -> Option<PathBuf> {
    if path.exists() {
        let c = path.canonicalize().ok()?;
        return Some(strip_unc_prefix(c));
    }
    let parent = path.parent()?;
    let basename = path.file_name()?;
    let canon_parent = if parent.as_os_str().is_empty() {
        std::env::current_dir().ok()?
    } else if parent.exists() {
        parent.canonicalize().ok()?
    } else {
        return None;
    };
    Some(strip_unc_prefix(canon_parent.join(basename)))
}

/// Turns a Windows verbatim path from canonicalize() back into its ordinary
/// form: `\\?\C:\x` becomes `C:\x` and `\\?\UNC\server\share\x` becomes
/// `\\server\share\x`. Stripping only `\\?\` used to leave the relative
/// path `UNC\server\share\x`, which broke network folders. Other verbatim
/// forms (volume GUIDs) have no ordinary spelling and are kept.
#[cfg_attr(not(windows), allow(dead_code))]
fn simplify_verbatim_path(path: &str) -> std::borrow::Cow<'_, str> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return std::borrow::Cow::Owned(format!(r"\\{rest}"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return std::borrow::Cow::Borrowed(rest);
        }
    }
    std::borrow::Cow::Borrowed(path)
}

#[cfg(windows)]
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") {
        let simplified = simplify_verbatim_path(&s).into_owned();
        PathBuf::from(simplified)
    } else {
        p
    }
}
#[cfg(not(windows))]
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    p
}

fn grants() -> &'static std::sync::Mutex<Vec<PathGrant>> {
    FILE_GRANTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Issues a single-file grant for the given path. Idempotent.
fn grant_file(path: &std::path::Path) {
    let Some(canonical) = canonical_form(path) else {
        return;
    };
    if let Ok(mut g) = grants().lock() {
        if !g.iter().any(|x| !x.recursive && x.canonical == canonical) {
            g.push(PathGrant {
                canonical,
                recursive: false,
            });
        }
    }
}

/// Issues a recursive folder grant. The folder itself and any descendants
/// (after canonicalization) become accessible.
fn grant_folder(path: &std::path::Path) {
    let Some(canonical) = canonical_form(path) else {
        return;
    };
    if let Ok(mut g) = grants().lock() {
        if !g.iter().any(|x| x.recursive && x.canonical == canonical) {
            g.push(PathGrant {
                canonical,
                recursive: true,
            });
        }
    }
}

/// Returns true if any active grant covers this path.
fn is_authorized(path: &std::path::Path) -> bool {
    let Some(canonical) = canonical_form(path) else {
        return false;
    };
    let Ok(g) = grants().lock() else {
        return false;
    };
    g.iter().any(|x| {
        if x.recursive {
            canonical.starts_with(&x.canonical)
        } else {
            canonical == x.canonical
        }
    })
}

/// Validates the path AND verifies a grant covers it.
/// This is the standard guard for fs commands that take a user-supplied path.
fn authorize_path(path: &str) -> Result<PathBuf, String> {
    let validated = validate_path(path)?;
    if !is_authorized(&validated) {
        if granted_but_folder_missing(&validated) {
            return Err(format!(
                "{PARENT_MISSING}: the folder that contained this file no longer exists. \
                 Use Save As to save it somewhere else."
            ));
        }
        return Err(
            "Access denied: this path has not been opened or saved in this session. \
             Open it via File → Open or by dragging it into the window."
                .to_string(),
        );
    }
    Ok(validated)
}

const PARENT_MISSING: &str = "ZITEXT_PARENT_MISSING";

/// A path the user opened (or a folder they granted) whose containing folder
/// was since deleted or renamed: it can't be canonicalized any more, so the
/// grant no longer matches, but it is the same path the user chose.
fn granted_but_folder_missing(path: &std::path::Path) -> bool {
    if canonical_form(path).is_some() || path.parent().is_none_or(|parent| parent.exists()) {
        return false;
    }
    grants().lock().is_ok_and(|g| {
        g.iter().any(|grant| {
            if grant.recursive {
                path.starts_with(&grant.canonical)
            } else {
                path == grant.canonical
            }
        })
    })
}

/// Ends access to a project folder the user closed or replaced, keeping
/// exact access to the files still open from it (so they can be saved).
/// Only paths that are authorized right now are kept, so this never widens
/// access.
#[tauri::command]
fn release_folder_access(folder: String, keep_paths: Vec<String>) {
    let Some(canonical) = canonical_form(std::path::Path::new(&folder)) else {
        return;
    };
    for path in keep_paths.iter().take(MAX_SESSION_FILES * 5) {
        if let Ok(authorized) = authorize_path(path) {
            if authorized.starts_with(&canonical) {
                grant_file(&authorized);
            }
        }
    }
    if let Ok(mut g) = grants().lock() {
        g.retain(|grant| !(grant.recursive && grant.canonical == canonical));
    }
}

/// Removes an exact-match file grant. Used by rename_file to clean up the old
/// path. Folder grants are left alone — the descendant the rename touched is
/// almost certainly still covered by the same folder grant.
fn revoke_file_grant(path: &std::path::Path) {
    let Some(canonical) = canonical_form(path) else {
        return;
    };
    if let Ok(mut g) = grants().lock() {
        g.retain(|x| x.recursive || x.canonical != canonical);
    }
}

/// Validates a file path to prevent path traversal attacks and access to system directories.
/// If the file exists, it's canonicalized. If not, it checks the path as provided.
fn validate_path(path: &str) -> Result<PathBuf, String> {
    let path_buf = PathBuf::from(path);

    // Use canonicalize if the path exists to resolve symlinks and relative segments.
    // If it doesn't exist (e.g., when saving a new file), normalize manually to
    // prevent path traversal via ".." components.
    let validated = if path_buf.exists() {
        path_buf
            .canonicalize()
            .map_err(|e| format!("Invalid file path: {}", e))?
    } else {
        // Manually normalize: walk components, reject any ".." that escapes the root.
        let mut normalized = PathBuf::new();
        for component in path_buf.components() {
            match component {
                std::path::Component::ParentDir => {
                    if !normalized.pop() {
                        return Err("Path traversal with '..' is not allowed".to_string());
                    }
                }
                std::path::Component::CurDir => {} // skip "."
                _ => normalized.push(component),
            }
        }
        normalized
    };

    #[cfg(unix)]
    let path_str = validated.to_string_lossy();

    // Only block virtual/pseudo-filesystems that cannot be meaningfully read
    // as text files (reading from them can hang or return garbage).
    // Legitimate real-filesystem locations like /etc, /root, and Windows
    // System32 are intentionally allowed — admins and power users regularly
    // edit configuration files there.
    #[cfg(unix)]
    {
        let virtual_prefixes = ["/proc", "/sys", "/dev"];
        for prefix in &virtual_prefixes {
            if path_str.starts_with(prefix)
                && (path_str.len() == prefix.len() || path_str[prefix.len()..].starts_with('/'))
            {
                return Err(format!(
                    "'{}' is a virtual filesystem and cannot be opened as a text file",
                    prefix
                ));
            }
        }
    }

    Ok(validated)
}

/// Strips the verbatim prefix that canonicalize() adds on Windows (see
/// `simplify_verbatim_path`); the frontend matches paths in ordinary form.
fn clean_path(path: PathBuf) -> String {
    strip_unc_prefix(path).to_string_lossy().to_string()
}

/// The main window's size and position (physical pixels), restored at the
/// next launch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

/// The window's current state, if it can be read.
fn capture_window_state(window: &tauri::WebviewWindow) -> Option<WindowState> {
    let maximized = window.is_maximized().unwrap_or(false);
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

/// True when a reasonable part of the window's title area lies on one of the
/// screens: a window saved on a monitor that is no longer connected must not
/// reopen out of reach.
fn window_state_visible(state: &WindowState, screens: &[(i32, i32, u32, u32)]) -> bool {
    const MIN_VISIBLE: i64 = 100;
    if state.width < 300 || state.height < 200 || state.width > 20_000 || state.height > 20_000 {
        return false;
    }
    screens.iter().any(|&(sx, sy, sw, sh)| {
        let (left, top) = (i64::from(state.x), i64::from(state.y));
        let right = left + i64::from(state.width);
        let (screen_left, screen_top) = (i64::from(sx), i64::from(sy));
        let (screen_right, screen_bottom) =
            (screen_left + i64::from(sw), screen_top + i64::from(sh));
        let overlap = right.min(screen_right) - left.max(screen_left);
        overlap >= MIN_VISIBLE && top >= screen_top && top < screen_bottom - 40
    })
}

fn restore_window_state(window: &tauri::WebviewWindow, state: WindowState) {
    let screens: Vec<_> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let (position, size) = (monitor.position(), monitor.size());
            (position.x, position.y, size.width, size.height)
        })
        .collect();
    if !window_state_visible(&state, &screens) {
        return;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    if state.maximized {
        let _ = window.maximize();
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    // Appearance, recent files, and last session
    theme: String,
    font_family: String,
    font_size: u32,
    word_wrap: bool,
    recent_files: Vec<String>,
    /// Stored in its own file (session.json) so that ordinary settings writes
    /// (recent files on every open and save) don't rewrite up to 32 MiB of
    /// recovery text. Still read from settings.json written by older versions.
    /// Written as [] so older versions, which require the key, can still
    /// read settings.json after a downgrade.
    #[serde(default, serialize_with = "serialize_empty_session")]
    last_session: Vec<SessionFile>,

    // Autosave, layout, and editor behavior
    #[serde(default)]
    autosave: String, // "off" | "afterDelay" | "onFocusChange"
    #[serde(default = "default_autosave_delay")]
    autosave_delay: u32, // milliseconds
    #[serde(default)]
    show_minimap: bool,
    #[serde(default = "default_editor_theme")]
    editor_theme: String,
    /// UI typeface for the app chrome — distinct from `font_family`, which is
    /// the editor's code font. Defaults to the design's Space Grotesk.
    #[serde(default = "default_ui_font")]
    ui_font: String,
    #[serde(default)]
    keybindings: HashMap<String, String>,
    #[serde(default)]
    opened_folder: Option<String>,
    #[serde(default = "default_sidebar_width")]
    sidebar_width: u32,
    #[serde(default)]
    sidebar_collapsed: bool,
    #[serde(default)]
    active_tab_path: Option<String>,
    /// Window size and position at the last quit (backend-owned).
    #[serde(default)]
    window_state: Option<WindowState>,
    #[serde(default = "default_enable_column_selection")]
    enable_column_selection: bool,

    // Indentation and formatting
    #[serde(default = "default_tab_size")]
    tab_size: u32,
    #[serde(default = "default_insert_spaces")]
    insert_spaces: bool,
    #[serde(default)]
    format_on_save: bool,

    // Updates
    #[serde(default = "default_check_for_updates")]
    check_for_updates: bool,
}

fn default_autosave_delay() -> u32 {
    2000
}
/// Mirrors DEFAULT_SETTINGS.uiFont in src/state/useSettingsManager.ts — a
/// mismatch shows as the chrome changing typeface once settings load.
fn default_ui_font() -> String {
    r#""Space Grotesk", system-ui, sans-serif"#.to_string()
}

fn default_editor_theme() -> String {
    "vs-dark".to_string()
}
fn default_sidebar_width() -> u32 {
    250
}
fn default_enable_column_selection() -> bool {
    false
}
fn default_tab_size() -> u32 {
    4
}
fn default_insert_spaces() -> bool {
    true
}
fn default_check_for_updates() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionFile {
    path: String,
    cursor_line: u32,
    cursor_column: u32,
    #[serde(default)]
    scroll_top: f64,
    #[serde(default)]
    scroll_left: f64,
    #[serde(default)]
    is_untitled: bool,
    /// Set when a saved (disk-backed) file had unsaved edits at snapshot time;
    /// `content` then carries those edits so crash recovery can re-apply them.
    #[serde(default)]
    is_dirty: bool,
    /// Marks the tab that was active, so restore can reselect it without exposing
    /// active_tab_path via the redacted `read_settings`.
    #[serde(default)]
    is_active: bool,
    /// Content preserved for untitled files (and dirty saved files) so they
    /// survive crashes and restarts. Capped by the renderer to avoid bloating
    /// the session file.
    #[serde(default)]
    content: Option<String>,
    /// For a dirty saved file: the on-disk version its unsaved edits were based
    /// on. Restore compares it with the file's current version so a change made
    /// after the crash is treated as a conflict instead of being overwritten.
    #[serde(default)]
    base_version: Option<SessionDiskVersion>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionDiskVersion {
    modified: u64,
    size: u64,
    hash: String,
}

/// SHA-256 hex digests are 64 characters; anything longer is malformed.
const MAX_SESSION_HASH_LEN: usize = 128;

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            // JetBrains Mono is bundled, so it resolves on every platform; the
            // rest of the chain only matters if the webview fails to load it.
            // Must match DEFAULT_SETTINGS.fontFamily in useSettingsManager.ts.
            font_family: r#""JetBrains Mono", "Menlo", "Monaco", "Consolas", monospace"#
                .to_string(),
            font_size: 14,
            word_wrap: false,
            recent_files: Vec::new(),
            last_session: Vec::new(),
            autosave: "off".to_string(),
            autosave_delay: 2000,
            show_minimap: false,
            editor_theme: "vs-dark".to_string(),
            ui_font: default_ui_font(),
            keybindings: HashMap::new(),
            opened_folder: None,
            sidebar_width: 250,
            sidebar_collapsed: false,
            active_tab_path: None,
            window_state: None,
            enable_column_selection: false,
            tab_size: 4,
            insert_spaces: true,
            format_on_save: false,
            check_for_updates: true,
        }
    }
}

fn get_config_path(app: tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config directory: {}", e))
        .map(|mut path| {
            path.push("settings.json");
            path
        })
}

/// Writes a user document through a same-directory temporary file and then
/// atomically replaces the destination. The temporary file is create-new,
/// inherits the destination's permissions when one exists, and is flushed
/// before publication.
fn atomic_write_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write(path, bytes, false)
}

/// Writes one of the app's own state files (settings and crash-recovery
/// data). These can hold unsaved document text, so they are always owner-only
/// (0600) in an owner-only directory (0700) on Unix, whatever the umask or the
/// previous file's permissions were.
fn atomic_write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    atomic_write(path, bytes, true)
}

/// Creates the app's config directory if needed and makes it owner-only.
fn ensure_private_dir(dir: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Tightens an existing app state file to owner-only (migration for files
/// written by older versions with the default umask, e.g. 0644).
fn make_owner_only(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::symlink_metadata(path) {
            if metadata.is_file() && metadata.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

const TEMP_WRITE_PREFIX: &str = ".zitext-write-";

/// True for the exact names tempfile produces for our atomic writes
/// (".zitext-write-" plus a 6-character random suffix).
fn is_atomic_temp_name(name: &str) -> bool {
    name.strip_prefix(TEMP_WRITE_PREFIX).is_some_and(|suffix| {
        suffix.len() == 6 && suffix.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

static SWEPT_TEMP_DIRS: OnceLock<std::sync::Mutex<HashSet<PathBuf>>> = OnceLock::new();

/// Removes temporary files left in `dir` by a save that was interrupted
/// (crash or kill between creating the temp file and replacing the target).
/// Only regular files with our exact temp-name pattern that are more than an
/// hour old are removed, and each directory is swept at most once per run.
fn sweep_stale_temp_files(dir: &std::path::Path) {
    let swept = SWEPT_TEMP_DIRS.get_or_init(|| std::sync::Mutex::new(HashSet::new()));
    match swept.lock() {
        Ok(mut seen) => {
            if !seen.insert(dir.to_path_buf()) {
                return;
            }
        }
        Err(_) => return,
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(is_atomic_temp_name) {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.is_file() && metadata.modified().is_ok_and(|modified| modified < cutoff) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Overwrites a file in place, keeping its inode and therefore its hard
/// links, ownership, ACLs and extended attributes. Not crash-atomic, so it is
/// used only where the atomic replace cannot work or would break the file:
/// if the write fails, the original content is put back.
fn write_in_place(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    let original =
        fs::read(path).map_err(|e| format!("Failed to read the file before saving: {e}"))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| format!("Failed to open the file for writing: {e}"))?;
    let written = file
        .set_len(0)
        .and_then(|_| file.write_all(bytes))
        .and_then(|_| file.sync_all());
    if let Err(error) = written {
        let _ = file
            .set_len(0)
            .and_then(|_| file.seek(SeekFrom::Start(0)))
            .and_then(|_| file.write_all(&original))
            .and_then(|_| file.sync_all());
        return Err(format!("Failed to write the file: {error}"));
    }
    Ok(())
}

/// A file with several hard links must be written in place: replacing it
/// would detach this name from the others, which would keep the old text.
#[cfg(unix)]
fn has_other_hard_links(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() > 1
}
#[cfg(not(unix))]
fn has_other_hard_links(_metadata: &fs::Metadata) -> bool {
    false
}

/// macOS: carry the original's ACL and extended attributes (Finder tags,
/// quarantine, custom metadata) over to the replacement. Best effort: the
/// save itself must not fail because metadata could not be copied.
#[cfg(target_os = "macos")]
fn copy_file_metadata(from: &std::path::Path, to: &std::path::Path) {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(from), Ok(to)) = (
        std::ffi::CString::new(from.as_os_str().as_bytes()),
        std::ffi::CString::new(to.as_os_str().as_bytes()),
    ) else {
        return;
    };
    // SAFETY: both arguments are valid NUL-terminated paths; a null state is
    // allowed by copyfile(3).
    unsafe {
        libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
        );
    }
}
#[cfg(not(target_os = "macos"))]
fn copy_file_metadata(_from: &std::path::Path, _to: &std::path::Path) {}

/// Replaces `path` with the temporary file. On Windows a reader that holds the
/// file without delete sharing (log tailers, antivirus) makes the replace fail
/// for a moment, so access-denied and sharing violations are retried briefly.
fn persist_with_retry(
    mut temp: tempfile::NamedTempFile,
    path: &std::path::Path,
) -> Result<(), std::io::Error> {
    let mut attempt = 0u64;
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(error) => {
                let retryable = cfg!(windows) && matches!(error.error.raw_os_error(), Some(5 | 32));
                if !retryable || attempt >= 5 {
                    return Err(error.error);
                }
                attempt += 1;
                temp = error.file;
                std::thread::sleep(std::time::Duration::from_millis(100 * attempt));
            }
        }
    }
}

fn atomic_write(path: &std::path::Path, bytes: &[u8], private: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;

    // Private files always keep tempfile's owner-only default (0600).
    let destination_metadata = if private {
        None
    } else {
        fs::metadata(path).ok()
    };
    if destination_metadata
        .as_ref()
        .is_some_and(has_other_hard_links)
    {
        return write_in_place(path, bytes);
    }
    let mut builder = tempfile::Builder::new();
    builder.prefix(TEMP_WRITE_PREFIX);
    #[cfg(unix)]
    if !private && destination_metadata.is_none() {
        use std::os::unix::fs::PermissionsExt;
        // Match normal file creation semantics (0666 & !umask), rather than
        // tempfile's owner-only default, for a newly-created user document.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temp = match builder.tempfile_in(parent) {
        Ok(temp) => temp,
        // The folder does not allow new files, but the document itself may
        // still be writable (shared folders with per-file permissions).
        Err(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied
                && destination_metadata.is_some() =>
        {
            return write_in_place(path, bytes);
        }
        Err(error) => return Err(format!("Failed to create temporary file: {error}")),
    };

    if let Some(metadata) = &destination_metadata {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| format!("Failed to preserve file permissions: {e}"))?;
    }

    temp.write_all(bytes)
        .map_err(|e| format!("Failed to write temporary file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to flush temporary file: {e}"))?;
    if destination_metadata.is_some() {
        copy_file_metadata(path, temp.path());
    }
    persist_with_retry(temp, path)
        .map_err(|e| format!("Failed to replace destination file: {e}"))?;

    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Failed to flush destination directory: {e}"))?;
    }

    sweep_stale_temp_files(parent);
    Ok(())
}

/// Shows the native Open File dialog, grants the chosen path, and returns it.
///
/// Not a `#[tauri::command]` — the renderer cannot invoke dialog primitives
/// directly. The only entry points are:
///   - Native menu items (handled in `on_menu_event`)
///   - The narrow `request_menu_action` command
async fn show_open_file_dialog(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let lock = OPEN_DIALOG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    // A oneshot send never blocks the thread running the callback (on
    // Windows the UI thread), unlike mpsc::blocking_send.
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog().file().pick_file(move |file_path| {
        let _ = tx.send(file_path.map(|p| p.to_string()));
    });

    // No timeout: the dialog stays open as long as the user needs, and its
    // result must not be dropped. The callback always runs when the
    // dialog closes.
    match rx.await {
        Ok(result) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            grant_file(&pb);
            clean_path(canonical_form(&pb).unwrap_or(pb))
        })),
        Err(_) => Ok(None),
    }
}

/// The renderer suggests the Save As name; reduce it to a plain file name so
/// it can't steer the dialog to another folder.
fn sanitize_default_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." || base.contains([':', '\0']) {
        return "Untitled.txt".to_string();
    }
    base.chars().take(255).collect()
}

/// Shows the native Save File dialog, grants the chosen target, and returns it.
/// Internal — see `show_open_file_dialog` for rationale.
async fn show_save_file_dialog(
    app: &tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let lock = SAVE_DIALOG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_file_name(sanitize_default_file_name(&default_name))
        .save_file(move |file_path| {
            let _ = tx.send(file_path.map(|p| p.to_string()));
        });

    // No timeout (see show_open_file_dialog). The path is returned resolved,
    // like a path that was opened, so "is this file already open in a tab"
    // compares the same spelling (letter case, symlinked folders).
    match rx.await {
        Ok(result) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            grant_file(&pb);
            clean_path(canonical_form(&pb).unwrap_or(pb))
        })),
        Err(_) => Ok(None),
    }
}

/// Triggers a native-menu-equivalent dialog from the renderer.
///
/// This is the *only* renderer-callable entry point for showing file dialogs.
/// The renderer cannot invoke the dialog functions directly (they are no
/// longer `#[tauri::command]`); it can only ask for one of a pre-declared set
/// of actions. A future input-recency check (Layer 2) would live here.
///
/// Dialog results are emitted as events the helper functions listen for:
///   - "open"        → `open-from-dialog` event, payload: Option<String> (path)
///   - "open_folder" → `folder-from-dialog` event, payload: Option<String> (path)
///   - "save_as"     → `save-from-dialog` event, payload: Option<String> (path)
#[tauri::command]
async fn request_menu_action(
    app: tauri::AppHandle,
    action: String,
    default_name: Option<String>,
) -> Result<(), String> {
    if DIALOG_REQUEST_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("A native dialog is already open".to_string());
    }
    struct DialogRequestGuard;
    impl Drop for DialogRequestGuard {
        fn drop(&mut self) {
            DIALOG_REQUEST_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _request_guard = DialogRequestGuard;

    if default_name.as_ref().is_some_and(|name| name.len() > 1024) {
        return Err("Default filename is too long".to_string());
    }

    match action.as_str() {
        "open" => {
            let result = show_open_file_dialog(&app).await?;
            app.emit("open-from-dialog", result)
                .map_err(|e| format!("Failed to emit event: {e}"))
        }
        "open_folder" => {
            let result = show_open_folder_dialog(&app).await?;
            app.emit("folder-from-dialog", result)
                .map_err(|e| format!("Failed to emit event: {e}"))
        }
        "save_as" => {
            let result = show_save_file_dialog(&app, default_name.unwrap_or_default()).await?;
            app.emit("save-from-dialog", result)
                .map_err(|e| format!("Failed to emit event: {e}"))
        }
        _ => Err(format!("Unknown menu action: {action}")),
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct FileReadResult {
    /// The path as the backend resolved it. Opening the same file through a
    /// different spelling (symlink, letter case, relative CLI path) yields
    /// the same value, so the renderer can reuse the existing tab.
    path: String,
    content: String,
    size: u64,
    encoding: String,
    modified: u64,
    hash: String,
    identity: String,
}

#[derive(Debug, Serialize)]
struct FileWriteResult {
    encoding: String,
    size: u64,
    modified: u64,
    hash: String,
    identity: String,
}

fn content_hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(unix)]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(any(unix, windows)))]
fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

// std only exposes by-handle file identity (volume serial number, file index,
// link count) behind the unstable `windows_by_handle` feature, so the checks
// below call `GetFileInformationByHandle` directly instead.

#[cfg(windows)]
fn windows_by_handle_info(handle: std::os::windows::io::RawHandle) -> Option<(u32, u64, u32)> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `handle` is a valid, open file handle for the duration of this
    // call, and `info` is a correctly-sized writable out-parameter.
    let ok = unsafe { GetFileInformationByHandle(handle as _, &mut info) };
    if ok == 0 {
        return None;
    }
    let file_index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Some((info.dwVolumeSerialNumber, file_index, info.nNumberOfLinks))
}

/// Opens `path` just far enough to read its by-handle identity, mirroring
/// what `fs::symlink_metadata`/`fs::metadata` do internally on Windows.
#[cfg(windows)]
fn windows_path_identity(path: &std::path::Path, follow_symlinks: bool) -> Option<(u32, u64, u32)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    if !follow_symlinks {
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).ok()?;
    windows_by_handle_info(file.as_raw_handle())
}

#[cfg(windows)]
fn windows_identity_matches_path(
    handle: std::os::windows::io::RawHandle,
    path: &std::path::Path,
    follow_symlinks: bool,
) -> bool {
    let handle_id = windows_by_handle_info(handle).map(|(volume, index, _)| (volume, index));
    let path_id =
        windows_path_identity(path, follow_symlinks).map(|(volume, index, _)| (volume, index));
    handle_id.is_some() && handle_id == path_id
}

fn open_regular_file(path: &std::path::Path) -> Result<(fs::File, fs::Metadata), String> {
    let (file, metadata) = open_regular_file_any_size(path)?;
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({:.1} MB). Maximum supported size is {} MB",
            metadata.len() as f64 / 1_048_576.0,
            MAX_FILE_SIZE / 1_048_576
        ));
    }
    Ok((file, metadata))
}

/// The checks of `open_regular_file` without the editor's size limit. The
/// large file viewer reads files of any size a piece at a time, so only the
/// editor (which loads the whole text) needs the limit.
fn open_regular_file_any_size(path: &std::path::Path) -> Result<(fs::File, fs::Metadata), String> {
    // Reject FIFOs, sockets, devices, and symlinks before open. Opening a FIFO
    // for reading can otherwise block an async-runtime worker indefinitely.
    let entry_metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect file before open: {e}"))?;
    if entry_metadata.file_type().is_symlink() || !entry_metadata.file_type().is_file() {
        return Err("Only regular files can be opened".to_string());
    }

    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    let file = options
        .open(path)
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect opened file: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("Only regular files can be opened".to_string());
    }
    #[cfg(not(windows))]
    let pre_open_identity_ok = same_file_identity(&entry_metadata, &metadata);
    #[cfg(windows)]
    let pre_open_identity_ok = {
        use std::os::windows::io::AsRawHandle;
        windows_identity_matches_path(file.as_raw_handle(), path, false)
    };
    if !pre_open_identity_ok {
        return Err("File changed during open; retry the operation".to_string());
    }
    // Re-resolve authority after opening and require the directory entry still
    // names this exact handle. This closes parent-directory/symlink swaps
    // between the original grant check and the open operation.
    if !is_authorized(path) {
        return Err("Access denied: file path changed during open".to_string());
    }
    #[allow(unused_variables)]
    let current_metadata =
        fs::metadata(path).map_err(|e| format!("Failed to revalidate opened file: {e}"))?;
    #[cfg(not(windows))]
    let post_open_identity_ok = same_file_identity(&metadata, &current_metadata);
    #[cfg(windows)]
    let post_open_identity_ok = {
        use std::os::windows::io::AsRawHandle;
        windows_identity_matches_path(file.as_raw_handle(), path, true)
    };
    if !post_open_identity_ok {
        return Err("File changed during open; retry the operation".to_string());
    }
    Ok((file, metadata))
}

fn read_bounded(file: fs::File) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(MAX_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    if bytes.len() > MAX_FILE_SIZE as usize {
        return Err(format!(
            "File too large. Maximum supported size is {} MB",
            MAX_FILE_SIZE / 1_048_576
        ));
    }
    Ok(bytes)
}

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const ENCODING_UTF8: &str = "UTF-8";
const ENCODING_UTF8_BOM: &str = "UTF-8 with BOM";
const ENCODING_WINDOWS_1252: &str = "Windows-1252";

/// True when the user can't write the file in place: no write permission
/// bits, no write access for this user (a file owned by someone else), or,
/// on macOS, a Finder-locked file. The atomic replace could still succeed in
/// a writable folder, so such files are only saved after confirmation.
fn is_write_protected(path: &std::path::Path, metadata: &fs::Metadata) -> bool {
    if metadata.permissions().readonly() {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        if metadata.st_flags() & (libc::UF_IMMUTABLE | libc::SF_IMMUTABLE) != 0 {
            return true;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        if let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) {
            // SAFETY: a valid NUL-terminated path; access(2) only reads it.
            if unsafe { libc::access(c_path.as_ptr(), libc::W_OK) } != 0 {
                let error = std::io::Error::last_os_error().raw_os_error();
                return matches!(error, Some(libc::EACCES | libc::EPERM | libc::EROFS));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    false
}

/// Decodes a document and names its encoding so saving can reproduce it.
///
/// - UTF-8, with or without a byte-order mark. The BOM is remembered (as
///   "UTF-8 with BOM") instead of being silently dropped on save.
/// - Anything else that is not valid UTF-8 is Windows-1252, decoded byte for
///   byte (no BOM sniffing), which round-trips every byte on save.
/// - UTF-16 is refused with a clear message. encoding_rs sniffs a UTF-16 BOM
///   even when asked for UTF-8, which used to convert such files to UTF-8
///   silently on the next save.
fn decode_text(bytes: &[u8]) -> Result<(String, &'static str), String> {
    reject_utf16(bytes)?;
    let has_bom = bytes.starts_with(&UTF8_BOM);
    let body = if has_bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        bytes
    };
    match std::str::from_utf8(body) {
        Ok(text) => Ok((
            text.to_string(),
            if has_bom {
                ENCODING_UTF8_BOM
            } else {
                ENCODING_UTF8
            },
        )),
        Err(_) => {
            let (decoded, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(bytes);
            Ok((decoded.into_owned(), ENCODING_WINDOWS_1252))
        }
    }
}

fn reject_utf16(bytes: &[u8]) -> Result<(), String> {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err("This file is UTF-16 encoded, which ZITEXT can't edit yet. Convert it to UTF-8 to open it.".to_string());
    }
    Ok(())
}

/// Encodes a document in its encoding (see `decode_text`).
fn encode_text(content: &str, encoding: &str) -> Result<(Vec<u8>, &'static str), String> {
    if encoding.eq_ignore_ascii_case(ENCODING_WINDOWS_1252) {
        let (encoded, _, had_errors) = encoding_rs::WINDOWS_1252.encode(content);
        if had_errors {
            return Err(
                "ZITEXT_ENCODING_UNREPRESENTABLE: this document contains characters that cannot be represented in Windows-1252."
                    .to_string(),
            );
        }
        Ok((encoded.into_owned(), ENCODING_WINDOWS_1252))
    } else if encoding.eq_ignore_ascii_case(ENCODING_UTF8_BOM) {
        let mut bytes = Vec::with_capacity(UTF8_BOM.len() + content.len());
        bytes.extend_from_slice(&UTF8_BOM);
        bytes.extend_from_slice(content.as_bytes());
        Ok((bytes, ENCODING_UTF8_BOM))
    } else {
        Ok((content.as_bytes().to_vec(), ENCODING_UTF8))
    }
}

fn read_file_content_sync(validated_path: PathBuf) -> Result<FileReadResult, String> {
    // Open once with no-follow semantics, then validate/read through that same
    // handle so metadata and bytes cannot refer to different files.
    let (file, metadata) = open_regular_file(&validated_path)?;
    let size = metadata.len();
    let modified =
        modified_millis(&metadata).ok_or_else(|| "Failed to get modification time".to_string())?;
    let bytes = read_bounded(file)?;
    let hash = content_hash(&bytes);

    dlog!("File read successfully, {} bytes", bytes.len());

    // UTF-16 first: its ASCII text is full of NUL bytes, so the binary check
    // below would otherwise give a misleading message.
    reject_utf16(&bytes)?;
    // Binary detection: check the first 8 KB for null bytes.
    let check_len = bytes.len().min(8192);
    if bytes[..check_len].contains(&0u8) {
        return Err("This file appears to be binary. ZITEXT is a text editor and cannot display binary content.".to_string());
    }

    let (content, encoding) = decode_text(&bytes)?;
    Ok(FileReadResult {
        path: clean_path(validated_path.clone()),
        content,
        size,
        encoding: encoding.to_string(),
        modified,
        hash,
        identity: file_identity(&validated_path, &metadata),
    })
}

#[tauri::command]
async fn read_file_content(path: String) -> Result<FileReadResult, String> {
    let _operation_permit = fs_operation_permit().await?;
    dlog!("Request to read file: {}", path);

    // Reads require a live grant. Recent-files / session-restore reopens get
    // grants from the session-restore prompt at launch and from Recent-Files
    // menu clicks — never from the renderer auto-claiming a path is "recent".
    let validated_path = match authorize_path(&path) {
        Ok(p) => {
            dlog!("Path authorized: {:?}", p);
            p
        }
        Err(e) => {
            dlog!("Path authorization failed: {}", e);
            return Err(e);
        }
    };

    tokio::task::spawn_blocking(move || read_file_content_sync(validated_path))
        .await
        .map_err(|e| format!("File reader worker failed: {e}"))?
}

fn write_file_content_sync(
    validated_path: PathBuf,
    content: String,
    encoding: Option<String>,
    expected_modified: Option<u64>,
    expected_size: Option<u64>,
    expected_hash: Option<String>,
    allow_read_only: bool,
) -> Result<FileWriteResult, String> {
    if let Some(expected_hash) = expected_hash {
        let (current, metadata) = open_regular_file(&validated_path).map_err(|_| {
            "ZITEXT_FILE_CONFLICT: file changed or was removed before save".to_string()
        })?;
        let current_bytes = read_bounded(current)?;
        let current_modified = modified_millis(&metadata).unwrap_or(0);
        if expected_modified != Some(current_modified)
            || expected_size != Some(metadata.len())
            || expected_hash != content_hash(&current_bytes)
        {
            return Err(
                "ZITEXT_FILE_CONFLICT: file changed on disk since it was opened. Reload or review the external change before saving."
                    .to_string(),
            );
        }
    }

    // A read-only file is protected on purpose (version control locks,
    // generated files). The atomic replace would silently succeed, so ask the
    // user first; the replacement keeps the read-only permission.
    let destination_read_only = fs::metadata(&validated_path)
        .map(|metadata| is_write_protected(&validated_path, &metadata))
        .unwrap_or(false);
    if destination_read_only && !allow_read_only {
        return Err("ZITEXT_READ_ONLY_FILE: this file is read-only on disk.".to_string());
    }

    let (bytes, saved_encoding) =
        encode_text(&content, encoding.as_deref().unwrap_or(ENCODING_UTF8))?;
    drop(content);
    // The limit applies to what is written: a Windows-1252 file can be well
    // under it while its text is larger in UTF-8.
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({:.1} MB). Maximum supported size is {} MB",
            bytes.len() as f64 / 1_048_576.0,
            MAX_FILE_SIZE / 1_048_576
        ));
    }

    #[cfg(windows)]
    if destination_read_only {
        // Windows refuses to replace a read-only file; clear the flag for the
        // replacement and set it again on the new file below.
        let mut permissions = fs::metadata(&validated_path)
            .map_err(|e| format!("Failed to inspect file: {e}"))?
            .permissions();
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&validated_path, permissions);
    }

    let written = atomic_write_file(&validated_path, &bytes);
    #[cfg(windows)]
    if destination_read_only {
        if let Ok(metadata) = fs::metadata(&validated_path) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(true);
            let _ = fs::set_permissions(&validated_path, permissions);
        }
    }
    written.map_err(|e| {
        dlog!("File write error: {}", e);
        format!("Failed to write file: {e}")
    })?;

    let metadata =
        fs::metadata(&validated_path).map_err(|e| format!("Failed to inspect saved file: {e}"))?;
    Ok(FileWriteResult {
        encoding: saved_encoding.to_string(),
        size: metadata.len(),
        modified: modified_millis(&metadata).unwrap_or(0),
        hash: content_hash(&bytes),
        identity: file_identity(&validated_path, &metadata),
    })
}

#[tauri::command]
async fn write_file_content(
    path: String,
    content: String,
    encoding: Option<String>,
    expected_modified: Option<u64>,
    expected_size: Option<u64>,
    expected_hash: Option<String>,
    allow_read_only: Option<bool>,
) -> Result<FileWriteResult, String> {
    // Writes do not take the shared filesystem permit, so a long search or
    // metadata polling can't delay a save. They are serialized by
    // FILE_WRITE_LOCK below (one write at a time, including renames).
    dlog!("Request to write file: {}", path);
    // Writes require a live grant. This includes exact grants restored through
    // the backend-owned recent-files list; SECURITY.md documents that deliberate
    // convenience/security trade-off. Arbitrary renderer-supplied paths fail.
    let validated_path = match authorize_path(&path) {
        Ok(p) => {
            dlog!("Path authorized: {:?}", p);
            p
        }
        Err(e) => {
            dlog!("Path authorization failed: {}", e);
            return Err(e);
        }
    };

    // The exact limit is checked after encoding. This only bounds the work:
    // no Windows-1252 text is more than three times its encoded size.
    if content.len() > 3 * MAX_FILE_SIZE as usize {
        return Err(format!(
            "File too large ({:.1} MB). Maximum supported size is {} MB",
            content.len() as f64 / 1_048_576.0,
            MAX_FILE_SIZE / 1_048_576
        ));
    }

    // Serialize native writes so the version check and atomic replacement are
    // one operation even if multiple renderer tasks target the same path.
    let _write_guard = FILE_WRITE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    tokio::task::spawn_blocking(move || {
        write_file_content_sync(
            validated_path,
            content,
            encoding,
            expected_modified,
            expected_size,
            expected_hash,
            allow_read_only.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| format!("File writer worker failed: {e}"))?
}

/// Full settings read for INTERNAL use only (not a command). Includes
/// `last_session`, which holds previous-session file paths and preserved unsaved
/// buffer content — that data must not reach the renderer before restore consent.
async fn load_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let config_path = get_config_path(app)?;
    load_settings_from_path(&config_path)
}

fn serialize_empty_session<S: serde::Serializer>(
    _: &[SessionFile],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(std::iter::empty::<SessionFile>())
}

fn session_path_for(config_path: &std::path::Path) -> PathBuf {
    config_path.with_file_name("session.json")
}

/// The Scratchpad: one note kept beside the settings (owner-only, like
/// them), saved as the user types and back on the next launch, with no file
/// name and no Save dialog.
const MAX_SCRATCHPAD_BYTES: usize = 5 * 1024 * 1024;

fn scratchpad_path_for(config_path: &std::path::Path) -> PathBuf {
    config_path.with_file_name("scratchpad.txt")
}

/// One scratchpad write at a time, so an older text can't land after a newer one.
static SCRATCHPAD_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn read_scratchpad_file(path: &std::path::Path) -> Result<String, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("Couldn't read the scratchpad: {error}")),
    };
    if !metadata.is_file() {
        return Err("The scratchpad file isn't a regular file.".to_string());
    }
    if metadata.len() > MAX_SCRATCHPAD_BYTES as u64 {
        return Err("The scratchpad file is too large to open.".to_string());
    }
    make_owner_only(path);
    let bytes = fs::read(path).map_err(|e| format!("Couldn't read the scratchpad: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn write_scratchpad_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    if content.len() > MAX_SCRATCHPAD_BYTES {
        return Err(
            "The scratchpad holds up to 5 MB of text. Save larger text as a file.".to_string(),
        );
    }
    atomic_write_private(path, content.as_bytes())
}

#[tauri::command]
async fn read_scratchpad(app: tauri::AppHandle) -> Result<String, String> {
    let path = scratchpad_path_for(&get_config_path(app)?);
    tauri::async_runtime::spawn_blocking(move || read_scratchpad_file(&path))
        .await
        .map_err(|e| format!("Couldn't read the scratchpad: {e}"))?
}

#[tauri::command]
async fn write_scratchpad(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let path = scratchpad_path_for(&get_config_path(app)?);
    let _guard = SCRATCHPAD_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    tauri::async_runtime::spawn_blocking(move || write_scratchpad_file(&path, &content))
        .await
        .map_err(|e| format!("Couldn't save the scratchpad: {e}"))?
}

/// Hash of the session file content last written, so an unchanged session
/// (most saves, most periodic snapshots) is not written again.
static LAST_SESSION_WRITE: OnceLock<std::sync::Mutex<Option<(PathBuf, String)>>> = OnceLock::new();

fn load_settings_from_path(config_path: &std::path::Path) -> Result<AppSettings, String> {
    let mut settings = load_settings_file(config_path)?;
    // The recovery session lives in session.json; settings.json from older
    // versions still carries it inline, which is used until the first write.
    let session_path = session_path_for(config_path);
    if session_path.exists() {
        make_owner_only(&session_path);
        let parsed = fs::metadata(&session_path)
            .map_err(|e| e.to_string())
            .and_then(|metadata| {
                if metadata.len() > MAX_SETTINGS_BYTES as u64 {
                    Err("oversized".to_string())
                } else {
                    fs::read(&session_path).map_err(|e| e.to_string())
                }
            })
            .and_then(|bytes| {
                serde_json::from_slice::<Vec<SessionFile>>(&bytes).map_err(|e| e.to_string())
            });
        match parsed {
            Ok(session) => settings.last_session = session,
            Err(_error) => {
                dlog!("Recovering corrupt session file: {}", _error);
                quarantine_settings_file(&session_path, "corrupt");
            }
        }
    }
    Ok(settings)
}

fn write_settings_files(
    config_path: &std::path::Path,
    settings: &AppSettings,
) -> Result<(), String> {
    let session = serde_json::to_string(&settings.last_session)
        .map_err(|e| format!("Failed to serialize recovery data: {}", e))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    if json.len() + session.len() > MAX_SETTINGS_BYTES {
        return Err(format!(
            "Settings and recovery data exceed the {} MB limit",
            MAX_SETTINGS_BYTES / 1_048_576
        ));
    }

    // Session first: once settings.json no longer carries an inline session
    // (older format), session.json must already hold it.
    let session_path = session_path_for(config_path);
    let digest = content_hash(session.as_bytes());
    let cache = LAST_SESSION_WRITE.get_or_init(|| std::sync::Mutex::new(None));
    let unchanged = session_path.exists()
        && cache
            .lock()
            .map(|last| {
                last.as_ref()
                    .is_some_and(|(path, hash)| *path == session_path && *hash == digest)
            })
            .unwrap_or(false);
    if !unchanged {
        atomic_write_private(&session_path, session.as_bytes())?;
        if let Ok(mut last) = cache.lock() {
            *last = Some((session_path, digest));
        }
    }
    atomic_write_private(config_path, json.as_bytes())
}

fn load_settings_file(config_path: &std::path::Path) -> Result<AppSettings, String> {
    if !config_path.exists() {
        return Ok(AppSettings::default());
    }
    make_owner_only(config_path);

    if let Ok(metadata) = fs::metadata(config_path) {
        if metadata.len() > MAX_SETTINGS_BYTES as u64 {
            quarantine_settings_file(config_path, "oversized");
            return Ok(AppSettings::default());
        }
    }

    let bytes = fs::read(config_path).map_err(|e| format!("Failed to read settings: {}", e))?;
    // Invalid UTF-8 is corruption like invalid JSON. Returning an error here
    // used to make every later settings, recent-files and crash-recovery
    // write fail until the user deleted the file by hand.
    let parsed = std::str::from_utf8(&bytes)
        .map_err(|e| e.to_string())
        .and_then(|content| serde_json::from_str(content).map_err(|e| e.to_string()));
    match parsed {
        Ok(settings) => Ok(settings),
        Err(_error) => {
            dlog!("Recovering corrupt settings file: {}", _error);
            quarantine_settings_file(config_path, "corrupt");
            Ok(AppSettings::default())
        }
    }
}

/// Corrupt-settings backups kept for diagnosis. They can contain recovered
/// document text, so they are owner-only and only the newest few are kept.
const MAX_SETTINGS_BACKUPS: usize = 3;

fn quarantine_settings_file(config_path: &std::path::Path, reason: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    // Named after the file it replaces ("session.corrupt.…" for the session
    // file), so a damaged session is not mistaken for damaged settings.
    let stem = backup_stem(config_path);
    // Unique even for several quarantines in the same millisecond.
    let mut backup = config_path.with_file_name(format!("{stem}.{reason}.{timestamp}.json"));
    let mut counter = 1;
    while backup.exists() {
        backup = config_path.with_file_name(format!("{stem}.{reason}.{timestamp}-{counter}.json"));
        counter += 1;
    }
    if fs::rename(config_path, &backup).is_ok() {
        make_owner_only(&backup);
    }
    if let Some(dir) = config_path.parent() {
        prune_settings_backups(dir, stem);
    }
}

/// "settings" or "session": the kinds of file that are set aside when damaged.
fn backup_stem(path: &std::path::Path) -> &'static str {
    match path.file_stem().and_then(|stem| stem.to_str()) {
        Some("session") => "session",
        _ => "settings",
    }
}

fn is_settings_backup_name(name: &str, stem: &str) -> bool {
    [".corrupt.", ".oversized."].iter().any(|kind| {
        name.strip_prefix(stem)
            .is_some_and(|rest| rest.starts_with(kind))
    }) && name.ends_with(".json")
}

/// Keeps the newest backups of one kind; settings and session backups have
/// a budget each, so a run of damaged session files can't push out the
/// settings backup a user may still need.
fn prune_settings_backups(dir: &std::path::Path, stem: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| is_settings_backup_name(name, stem))
        })
        .filter_map(|entry| {
            let metadata = fs::symlink_metadata(entry.path()).ok()?;
            metadata.is_file().then(|| {
                (
                    metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                    entry.path(),
                )
            })
        })
        .collect();
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.0));
    for (_, stale) in backups.into_iter().skip(MAX_SETTINGS_BACKUPS) {
        let _ = fs::remove_file(stale);
    }
}

/// Renderer-facing settings read. Redacts `last_session` so a compromised
/// renderer cannot read previous-session file paths or preserved unsaved
/// content before the consent-gated session-restore prompt. Session data is
/// returned only by `get_last_session`, which blocks until the user confirms.
#[tauri::command]
async fn read_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let mut settings = load_settings(app).await?;
    // Redact session state from the renderer-facing read. Session data (paths,
    // preserved unsaved content, active-tab pointer) is returned only by the
    // consent-gated get_last_session.
    settings.last_session = Vec::new();
    settings.active_tab_path = None;
    Ok(settings)
}

/// Returns whether a settings.json already exists. The renderer uses this as an
/// explicit first-run signal: `read_settings` returns `AppSettings::default()`
/// (theme = "dark") for a missing file, so it cannot tell "no file yet" from
/// "saved all-defaults". On true first run the renderer derives the initial
/// theme from the OS instead of the hard-coded dark default.
#[tauri::command]
async fn settings_file_exists(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(get_config_path(app)?.exists())
}

/// Serializes read-modify-write access to settings.json so concurrent writers
/// (save_session, write_settings, add_recent_file) can't clobber each other's
/// changes across the load→write await gap on Tauri's multi-threaded runtime.
static SETTINGS_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
fn settings_lock() -> &'static tokio::sync::Mutex<()> {
    SETTINGS_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Writes the full settings struct to disk atomically. Internal — callers must
/// supply a complete, correct `AppSettings` (including `last_session`) and hold
/// `settings_lock()` across their read→write span.
async fn write_settings_to_disk(
    app: tauri::AppHandle,
    settings: AppSettings,
) -> Result<(), String> {
    let config_path = get_config_path(app)?;
    write_settings_files(&config_path, &settings)
}

/// Renderer-facing settings write. `last_session` is backend-owned (written only
/// by `save_session`) and is redacted from the renderer-facing `read_settings`,
/// so the renderer never holds the real value. Preserve whatever is on disk
/// instead of letting an ordinary settings write (theme/font change, etc.) clobber
/// the saved session.
#[tauri::command]
async fn write_settings(app: tauri::AppHandle, mut settings: AppSettings) -> Result<(), String> {
    let _guard = settings_lock().lock().await;
    let current = load_settings(app.clone()).await?;
    settings = preserve_authority_settings(settings, &current);
    write_settings_to_disk(app, settings).await
}

fn preserve_authority_settings(mut incoming: AppSettings, current: &AppSettings) -> AppSettings {
    // Authority-bearing fields are backend-owned. Preserve their on-disk
    // values so renderer-provided preferences cannot mint filesystem grants.
    incoming.recent_files = current.recent_files.clone();
    incoming.opened_folder = current.opened_folder.clone();
    incoming.last_session = current.last_session.clone();
    incoming.active_tab_path = current.active_tab_path.clone();
    incoming.window_state = current.window_state;
    incoming
}

#[tauri::command]
async fn get_recent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let settings = load_settings(app).await?;
    Ok(existing_recent_files(settings.recent_files).await)
}

/// Recent files that still exist. Missing ones are hidden, not forgotten: a
/// file on an unmounted drive comes back when the drive does. A check that
/// takes too long (a share that doesn't answer) shows the list unfiltered.
async fn existing_recent_files(files: Vec<String>) -> Vec<String> {
    let all = files.clone();
    let check = tokio::task::spawn_blocking(move || {
        files
            .into_iter()
            .filter(|path| std::path::Path::new(path).exists())
            .collect::<Vec<_>>()
    });
    match tokio::time::timeout(std::time::Duration::from_secs(2), check).await {
        Ok(Ok(existing)) => existing,
        _ => all,
    }
}

#[tauri::command]
async fn add_recent_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Recent files are authority-bearing. Only an already-granted file can be
    // inserted; native dialogs/CLI/OS open events issue that grant.
    let validated = validate_recent_candidate(&path)?;
    let clean = clean_path(validated);

    let _guard = settings_lock().lock().await;
    let mut settings = load_settings(app.clone()).await?;

    // Remove if already exists
    settings.recent_files.retain(|p| p != &clean);

    // Add to front
    settings.recent_files.insert(0, clean);

    // Keep only last 10
    settings.recent_files.truncate(10);

    write_settings_to_disk(app, settings).await
}

fn validate_recent_candidate(path: &str) -> Result<PathBuf, String> {
    let validated = authorize_path(path)?;
    if !validated.is_file() {
        return Err("Only regular files can be added to recent files".to_string());
    }
    Ok(validated)
}

#[tauri::command]
async fn set_opened_folder(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    let clean = match path {
        Some(path) => {
            let validated = authorize_path(&path)?;
            if !validated.is_dir() {
                return Err("Opened folder path is not a directory".to_string());
            }
            Some(clean_path(validated))
        }
        None => None,
    };

    let _guard = settings_lock().lock().await;
    let mut settings = load_settings(app.clone()).await?;
    settings.opened_folder = clean;
    write_settings_to_disk(app, settings).await
}

#[tauri::command]
async fn save_session(
    app: tauri::AppHandle,
    mut session: Vec<SessionFile>,
    active_tab_path: Option<String>,
) -> Result<(), String> {
    // The previous session may still hold unanswered crash-recovery data.
    // Replacing it now (e.g. with only the files the app was launched with)
    // would lose that data, so snapshots wait until the prompt is answered.
    if session_decision_atomic().load(std::sync::atomic::Ordering::SeqCst) == 0 {
        return Ok(());
    }

    let _guard = settings_lock().lock().await;
    // Checked under the lock: a snapshot that was already in flight when the
    // user quit must not put back the session confirm_app_close just cleared.
    if close_confirmed().load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let mut settings = load_settings(app.clone()).await?;
    if SESSION_LATE_RESTORE_PENDING.load(std::sync::atomic::Ordering::SeqCst) {
        // A late "Restore" has not reached the renderer yet, and may never
        // (if the window crashed). Keep the stored files it has not reopened
        // instead of refusing every snapshot, which left the rest of the
        // session without crash recovery.
        session = keep_unrestored_entries(session, std::mem::take(&mut settings.last_session));
    }
    let active_tab_path = validate_session_entries(&mut session, active_tab_path);
    settings.last_session = session;
    settings.active_tab_path = active_tab_path;
    write_settings_to_disk(app, settings).await
}

/// A snapshot taken while a late "Restore" is pending: the renderer's tabs
/// first, then every stored file entry it does not have open (with its
/// recovery content), up to the session limit.
fn keep_unrestored_entries(
    mut session: Vec<SessionFile>,
    stored: Vec<SessionFile>,
) -> Vec<SessionFile> {
    let key = |path: &str| {
        canonical_form(std::path::Path::new(path))
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    };
    let open: std::collections::HashSet<String> = session
        .iter()
        .filter(|entry| !entry.is_untitled)
        .map(|entry| key(&entry.path))
        .collect();
    for mut entry in stored {
        if session.len() >= MAX_SESSION_FILES {
            break;
        }
        // Untitled entries were handed to the renderer before it stopped
        // waiting, so they are already among its tabs.
        if entry.is_untitled || open.contains(&key(&entry.path)) {
            continue;
        }
        entry.is_active = false;
        session.push(entry);
    }
    session
}

/// Normalizes a renderer-supplied session snapshot. Problems with one entry
/// never reject the whole snapshot (which used to disable crash recovery for
/// every tab): unauthorized or malformed entries are dropped, and recovery
/// content beyond the per-buffer and total budgets is stripped, keeping the
/// renderer's order (it lists the most important buffers first within its
/// budget). Returns the validated active tab path, if any.
fn validate_session_entries(
    session: &mut Vec<SessionFile>,
    active_tab_path: Option<String>,
) -> Option<String> {
    session.retain_mut(|entry| {
        if entry.path.len() > 32 * 1024 {
            return false;
        }
        if entry
            .base_version
            .as_ref()
            .is_some_and(|version| version.hash.len() > MAX_SESSION_HASH_LEN)
        {
            entry.base_version = None;
        }
        if entry.is_untitled {
            return true;
        }
        match authorize_path(&entry.path) {
            Ok(authorized) => {
                entry.path = clean_path(authorized);
                true
            }
            // The file's folder was deleted or renamed: keep the entry (and
            // its unsaved text) so the next launch can offer it as a
            // Recovered tab instead of losing it.
            Err(e) if e.starts_with(PARENT_MISSING) => true,
            Err(e) => {
                dlog!("Dropping session entry that is no longer authorized: {}", e);
                false
            }
        }
    });
    session.truncate(MAX_SESSION_FILES);

    let mut total_content_bytes = 0usize;
    for entry in session.iter_mut() {
        let Some(len) = entry.content.as_ref().map(String::len) else {
            continue;
        };
        let fits = len <= MAX_SESSION_CONTENT_BYTES
            && total_content_bytes.saturating_add(len) <= MAX_SESSION_TOTAL_BYTES;
        if fits {
            total_content_bytes += len;
        } else {
            entry.content = None;
            entry.is_dirty = false;
        }
    }
    // An untitled entry without content has nothing left to recover.
    session.retain(|entry| !entry.is_untitled || entry.content.is_some());

    let clean = clean_path(authorize_path(&active_tab_path?).ok()?);
    session
        .iter()
        .any(|entry| !entry.is_untitled && entry.path == clean)
        .then_some(clean)
}

#[tauri::command]
async fn get_last_session(app: tauri::AppHandle) -> Result<Vec<SessionFile>, String> {
    let settings = load_settings(app).await?;
    if settings.last_session.is_empty() {
        return Ok(Vec::new());
    }

    // Block until the startup session-restore prompt has resolved (or until
    // the no-prompt-needed path released waiters). On Skip, drop file-backed
    // entries so the renderer's restore code only sees untitled tabs (whose
    // inline content doesn't require a file-system grant).
    //
    // 30s timeout safety net so the renderer's startup never hangs if the
    // prompt is unanswered (or its callback never fires). A timeout is NOT a
    // Skip: only untitled entries are released now, the stored session stays
    // protected from snapshots, and a later "Restore" emits
    // `session-restore-late` so the renderer fetches the rest.
    let restore =
        match tokio::time::timeout(std::time::Duration::from_secs(30), wait_session_decision())
            .await
        {
            Ok(decision) => decision,
            Err(_) => {
                SESSION_LATE_RESTORE_PENDING.store(true, std::sync::atomic::Ordering::SeqCst);
                // The answer may have arrived between the timeout and the
                // store above, too late to see the flag and send the late
                // event. Take it into account here instead.
                match session_decision_atomic().load(std::sync::atomic::Ordering::SeqCst) {
                    0 => false,
                    decision => {
                        SESSION_LATE_RESTORE_PENDING
                            .store(false, std::sync::atomic::Ordering::SeqCst);
                        decision == 1
                    }
                }
            }
        };
    if restore {
        // This fetch consumes a late "Restore"; snapshots may resume.
        SESSION_LATE_RESTORE_PENDING.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    Ok(filter_session_for_restore(settings.last_session, restore))
}

fn filter_session_for_restore(session: Vec<SessionFile>, restore: bool) -> Vec<SessionFile> {
    if restore {
        session
    } else {
        session
            .into_iter()
            .filter(|entry| entry.is_untitled)
            .collect()
    }
}

#[tauri::command]
async fn get_startup_args() -> Result<Vec<String>, String> {
    // Mark that the frontend has consumed startup args; later requests are
    // sent as events. Flag and list change under one lock, so a request is
    // either in the list taken here or sent as an event, never neither.
    let args = STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let files = args
        .lock()
        .map(|mut v| {
            STARTUP_ARGS_CONSUMED
                .get_or_init(|| std::sync::atomic::AtomicBool::new(false))
                .store(true, std::sync::atomic::Ordering::SeqCst);
            std::mem::take(&mut *v)
        })
        .unwrap_or_default();
    Ok(files)
}

#[tauri::command]
async fn get_startup_folder() -> Result<Option<String>, String> {
    Ok(STARTUP_FOLDER
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .map(|mut folder| folder.take())
        .unwrap_or(None))
}

/// Queues the request while the renderer has not collected its startup files
/// (returns None); once it has, returns the request for sending as events.
fn queue_until_renderer_ready(
    files: Vec<String>,
    folder: Option<String>,
) -> Option<(Vec<String>, Option<String>)> {
    // The ready check and the queueing happen under the same lock that
    // get_startup_args holds while it sets the flag (see there).
    let Ok(mut pending) = STARTUP_ARGS
        .get_or_init(|| std::sync::Mutex::new(Vec::new()))
        .lock()
    else {
        return Some((files, folder));
    };
    let renderer_ready = STARTUP_ARGS_CONSUMED
        .get_or_init(|| std::sync::atomic::AtomicBool::new(false))
        .load(std::sync::atomic::Ordering::SeqCst);
    if renderer_ready {
        return Some((files, folder));
    }
    if let Some(folder) = folder {
        if let Ok(mut pending_folder) = STARTUP_FOLDER
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
        {
            *pending_folder = Some(folder);
        }
    }
    pending.extend(files);
    None
}

/// Hands files and a folder from outside (command line, a second launch,
/// Finder, drag and drop) to the renderer. Until the renderer has asked for
/// its startup files they are queued, because events emitted before its
/// listeners exist are lost; afterwards they are delivered as events.
fn deliver_open_requests(app: &tauri::AppHandle, files: Vec<String>, folder: Option<String>) {
    let Some((files, folder)) = queue_until_renderer_ready(files, folder) else {
        return;
    };
    if let Some(folder) = folder {
        let _ = app.emit("open-folder", folder);
    }
    for file in files {
        let _ = app.emit("open-file", file);
    }
}

#[derive(Default)]
struct ParsedCliArgs {
    files: Vec<String>,
    folder: Option<String>,
    wait_locks: Vec<(String, String)>,
}

fn parse_cli_args(args: &[String], cwd: &std::path::Path) -> ParsedCliArgs {
    let mut parsed = ParsedCliArgs::default();
    let mut pending_wait_lock: Option<String> = None;
    let mut index = 1;

    while index < args.len() {
        let argument = &args[index];
        if argument == "--wait-lock" {
            if let Some(lock) = args.get(index + 1) {
                pending_wait_lock = Some(lock.clone());
                index += 2;
                continue;
            }
            break;
        }
        if argument.starts_with('-') {
            index += 1;
            continue;
        }

        let resolved = if std::path::Path::new(argument).is_absolute() {
            PathBuf::from(argument)
        } else if cfg!(target_os = "macos") && cwd == std::path::Path::new("/") {
            // macOS LaunchServices starts apps in "/": a relative argument
            // then means nothing, and "." would open the whole disk. (On
            // Windows and Linux a shell at C:\ or / is a real working folder.)
            pending_wait_lock = None;
            index += 1;
            continue;
        } else {
            cwd.join(argument)
        };
        // One spelling per file, matching what reading the file reports, so
        // --wait bookkeeping and the tab agree on the path.
        let resolved = canonical_form(&resolved).unwrap_or(resolved);
        if resolved.exists() {
            if resolved.is_dir() {
                grant_folder(&resolved);
                parsed.folder = Some(clean_path(resolved));
                pending_wait_lock = None;
            } else if resolved.is_file() {
                grant_file(&resolved);
                let clean = clean_path(resolved);
                if let Some(lock) = pending_wait_lock.take() {
                    parsed.wait_locks.push((clean.clone(), lock));
                }
                parsed.files.push(clean);
            }
        } else {
            pending_wait_lock = None;
        }
        index += 1;
    }

    parsed
}

fn register_wait_lock(file_path: &str, lock_path: &str) -> Result<(), String> {
    let lock = PathBuf::from(lock_path);
    let metadata = fs::symlink_metadata(&lock).map_err(|e| format!("Invalid --wait lock: {e}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("Invalid --wait lock type".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
            return Err("--wait lock must be a private, single-link file".to_string());
        }
    }

    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| format!("Failed to resolve temp directory: {e}"))?;
    let canonical = lock
        .canonicalize()
        .map_err(|e| format!("Failed to resolve --wait lock: {e}"))?;
    let valid_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("zitext-wait."));
    if !valid_name || !(canonical.starts_with(&temp) || owned_by_current_user(&metadata)) {
        return Err(
            "--wait lock must be a zitext-wait.* file in the temp directory or owned by you"
                .to_string(),
        );
    }

    let mut options = fs::OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&canonical)
        .map_err(|e| format!("Failed to acknowledge --wait lock: {e}"))?;
    #[cfg_attr(windows, allow(unused_variables))]
    let opened_metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect --wait lock: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.dev() != opened_metadata.dev()
            || metadata.ino() != opened_metadata.ino()
            || opened_metadata.nlink() != 1
        {
            return Err("--wait lock changed during validation".to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        let pre_open = windows_path_identity(&lock, false);
        let opened = windows_by_handle_info(file.as_raw_handle());
        let identity_ok = match (pre_open, opened) {
            (Some((pre_volume, pre_index, _)), Some((open_volume, open_index, links))) => {
                pre_volume == open_volume && pre_index == open_index && links == 1
            }
            _ => false,
        };
        if !identity_ok {
            return Err("--wait lock changed during validation".to_string());
        }
    }
    file.set_len(0)
        .map_err(|e| format!("Failed to reset --wait lock: {e}"))?;
    file.write_all(b"accepted\n")
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("Failed to acknowledge --wait lock: {e}"))?;

    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut map = locks
        .lock()
        .map_err(|_| "Failed to register --wait lock".to_string())?;
    map.entry(file_path.to_string())
        .or_default()
        .push(clean_path(canonical));
    Ok(())
}

/// Moves `--wait` bookkeeping from a document's old path to its new one
/// (rename, Save As), so the waiting CLI is released when the tab that now
/// shows the document closes, not when an unrelated tab with the old path does.
fn retarget_wait_locks(old_path: &str, new_path: &str) {
    if old_path == new_path {
        return;
    }
    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut map) = locks.lock() {
        if let Some(lock_paths) = map.remove(old_path) {
            map.entry(new_path.to_string())
                .or_default()
                .extend(lock_paths);
        }
    }
}

/// Renderer notice that a tab now shows `new_path` instead of `old_path`
/// (Save As). Only moves existing bookkeeping; it grants nothing.
#[tauri::command]
fn retarget_document(old_path: String, new_path: String) {
    retarget_wait_locks(&old_path, &new_path);
}

/// The CLI wrapper's temp directory can differ from the app's (Linux: a
/// different TMPDIR when ZITEXT was already running), so a lock outside it
/// is accepted when it belongs to this user.
#[cfg(unix)]
fn owned_by_current_user(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and cannot fail.
    metadata.uid() == unsafe { libc::geteuid() }
}
#[cfg(not(unix))]
fn owned_by_current_user(_metadata: &fs::Metadata) -> bool {
    false
}

/// Final check before deleting a registered lock: still a regular
/// zitext-wait.* file, in the temp directory or owned by this user.
fn may_remove_wait_lock(lock: &std::path::Path) -> bool {
    let named = lock
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("zitext-wait."));
    let Ok(metadata) = fs::symlink_metadata(lock) else {
        return false;
    };
    let in_temp = std::env::temp_dir()
        .canonicalize()
        .ok()
        .map(|p| PathBuf::from(clean_path(p)))
        .is_some_and(|root| lock.starts_with(root));
    named && metadata.file_type().is_file() && (in_temp || owned_by_current_user(&metadata))
}

/// Signals that a tab with the given path was closed.
/// If a --wait lock file exists for this path, it is deleted so the CLI unblocks.
/// Async so the file deletion doesn't run on the main (UI) thread.
#[tauri::command]
async fn signal_tab_closed(path: String) -> Result<(), String> {
    release_wait_locks(path)
}

fn release_wait_locks(path: String) -> Result<(), String> {
    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut map) = locks.lock() {
        if let Some(lock_paths) = map.remove(&path) {
            for lock_path in lock_paths {
                // register_wait_lock already canonicalized and validated these;
                // check once more before deleting.
                if may_remove_wait_lock(std::path::Path::new(&lock_path)) {
                    let _ = fs::remove_file(&lock_path);
                }
            }
        }
    }
    Ok(())
}

/// Removes all outstanding --wait locks. This is used on a confirmed clean
/// application exit, where individual tab-close notifications may never run.
fn cleanup_wait_locks() {
    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let Ok(mut map) = locks.lock() else {
        return;
    };
    for lock_path in map.drain().flat_map(|(_, paths)| paths) {
        let lock = PathBuf::from(&lock_path);
        if may_remove_wait_lock(&lock) {
            let _ = fs::remove_file(lock);
        }
    }
}

fn start_wait_lock_heartbeat() {
    tauri::async_runtime::spawn(async {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let paths = WAIT_LOCKS
                .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
                .lock()
                .map(|map| map.values().flatten().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            for path in paths {
                let candidate = PathBuf::from(&path);
                if !fs::symlink_metadata(&candidate)
                    .is_ok_and(|metadata| metadata.file_type().is_file())
                {
                    continue;
                }
                let mut options = fs::OpenOptions::new();
                options.write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW);
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
                    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
                }
                if let Ok(file) = options.open(candidate) {
                    let times = fs::FileTimes::new().set_modified(std::time::SystemTime::now());
                    let _ = file.set_times(times);
                }
            }
        }
    });
}

// ============================================================================
// Directory and file-metadata commands
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
struct FileEntry {
    name: String,
    path: String,
    is_directory: bool,
    size: Option<u64>,
    modified: Option<u64>, // Unix timestamp
}

/// Shows the native Open Folder dialog, grants the chosen folder recursively,
/// and returns its path. Internal — see `show_open_file_dialog` for rationale.
async fn show_open_folder_dialog(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let lock = FOLDER_DIALOG_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;

    // oneshot::Sender::send() is non-blocking — safe to call from any thread,
    // including the Windows UI thread that fires the dialog callback. This avoids
    // the potential deadlock that blocking_send can cause on Windows when the
    // dialog callback runs synchronously on the same runtime context.
    let (tx, rx) = oneshot::channel::<Option<String>>();

    app.dialog().file().pick_folder(move |folder_path| {
        let _ = tx.send(folder_path.map(|p| p.to_string()));
    });

    // No timeout; see show_open_file_dialog.
    match rx.await {
        Ok(result) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            // User picked a folder — grant recursively so read_directory,
            // read_file_content of children, search_in_files etc. all work.
            grant_folder(&pb);
            clean_path(pb)
        })),
        Err(_) => Ok(None), // sender dropped without sending (dialog closed internally)
    }
}

/// A directory listing. A folder with more entries than the explorer can show
/// returns the first ones with `truncated` set, instead of failing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryListing {
    entries: Vec<FileEntry>,
    truncated: bool,
    /// Symbolic links (and Windows junctions) left out of the listing.
    hidden_links: u32,
}

#[tauri::command]
async fn read_directory(path: String, recursive: bool) -> Result<DirectoryListing, String> {
    let _operation_permit = fs_operation_permit().await?;
    use std::time::SystemTime;

    // Listing requires a grant covering the directory (usually a folder grant
    // from open_folder_dialog or CLI args).
    let validated_path = authorize_path(&path)?;

    fn read_dir_recursive(
        path: &std::path::Path,
        recursive: bool,
        depth: usize,
        entry_count: &mut usize,
        hidden_links: &mut u32,
    ) -> Result<Vec<FileEntry>, String> {
        let root_metadata =
            fs::symlink_metadata(path).map_err(|e| format!("Failed to inspect directory: {e}"))?;
        if root_metadata.file_type().is_symlink() || !root_metadata.file_type().is_dir() {
            return Err("Directory traversal encountered a non-directory or symlink".to_string());
        }
        // Check depth limit
        if depth > MAX_DIRECTORY_DEPTH {
            return Err(format!(
                "Directory depth limit ({}) exceeded. This may be a circular symlink or extremely deep structure.",
                MAX_DIRECTORY_DEPTH
            ));
        }

        if *entry_count >= MAX_DIRECTORY_ENTRIES {
            return Ok(Vec::new());
        }

        let mut entries = Vec::new();

        let dir_entries =
            fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in dir_entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();

            // Skip symlinks — prevents escaping the intended directory tree via
            // crafted or malicious symlinks. They are counted, so the explorer
            // can say that some entries are not shown.
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    *hidden_links += 1;
                    continue;
                }
                Ok(metadata) => Some(metadata),
                Err(_) => continue,
            };
            if !metadata
                .as_ref()
                .is_some_and(|value| value.is_file() || value.is_dir())
            {
                continue;
            }

            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // On Unix/macOS, do NOT skip dotfiles — they are ordinary config files
            // (.bashrc, .gitignore, .env, etc.) that users frequently edit.
            // On Windows, only skip entries that have the OS "hidden" attribute set
            // by the system or the user; dotfiles on Windows (.gitignore, .editorconfig)
            // are NOT hidden by default and should remain visible.
            #[cfg(unix)]
            let is_hidden = false;

            #[cfg(windows)]
            let is_hidden = {
                use std::os::windows::fs::MetadataExt;
                metadata
                    .as_ref()
                    .map(|m| {
                        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                        (m.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
                    })
                    .unwrap_or(false)
            };

            #[cfg(not(any(unix, windows)))]
            let is_hidden = false;

            if is_hidden {
                continue;
            }

            let is_directory = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata
                .as_ref()
                .and_then(|m| if !is_directory { Some(m.len()) } else { None });
            let modified = metadata.as_ref().and_then(|m| {
                m.modified().ok().and_then(|t| {
                    t.duration_since(SystemTime::UNIX_EPOCH)
                        .ok()
                        .map(|d| d.as_secs())
                })
            });

            // Enforce the cap inside the loop so a single huge flat directory
            // cannot blow past it; the caller reports the listing as truncated.
            if *entry_count >= MAX_DIRECTORY_ENTRIES {
                *entry_count += 1;
                break;
            }
            *entry_count += 1;

            entries.push(FileEntry {
                name,
                path: clean_path(path.clone()),
                is_directory,
                size,
                modified,
            });

            // Recursively read subdirectories if requested
            if recursive && is_directory {
                // Skip directories we cannot read.
                if let Ok(mut sub_entries) =
                    read_dir_recursive(&path, true, depth + 1, entry_count, hidden_links)
                {
                    entries.append(&mut sub_entries);
                }
            }
        }

        Ok(entries)
    }

    tokio::task::spawn_blocking(move || {
        let mut entry_count = 0;
        let mut hidden_links = 0;
        let entries = read_dir_recursive(
            &validated_path,
            recursive,
            0,
            &mut entry_count,
            &mut hidden_links,
        )?;
        Ok(DirectoryListing {
            entries,
            truncated: entry_count > MAX_DIRECTORY_ENTRIES,
            hidden_links,
        })
    })
    .await
    .map_err(|e| format!("Directory worker failed: {e}"))?
}

/// Explorer filter results: matching files plus the folders leading to them.
#[derive(Debug, Serialize)]
struct FileNameSearch {
    entries: Vec<FileEntry>,
    truncated: bool,
}

const MAX_FILE_NAME_MATCHES: usize = 1000;

fn find_file_names_recursive(
    dir: &std::path::Path,
    needle: &str,
    depth: usize,
    budget: &mut SearchBudget,
    found: &mut Vec<PathBuf>,
) {
    // A folder nested too deeply is skipped on its own; it must not end the
    // whole walk (siblings elsewhere in the tree are still searched).
    if depth > MAX_DIRECTORY_DEPTH {
        return;
    }
    if found.len() >= MAX_FILE_NAME_MATCHES || !budget.check() {
        budget.stopped = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if found.len() >= MAX_FILE_NAME_MATCHES || !budget.check() {
            budget.stopped = true;
            return;
        }
        budget.files_visited += 1;
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if metadata.is_dir() {
            if !is_generated_dir(&name) {
                find_file_names_recursive(&path, needle, depth + 1, budget, found);
            }
        } else if metadata.is_file() && name.contains(needle) {
            found.push(path);
        }
    }
}

/// Finds files by name anywhere in the opened folder for the explorer filter
/// (it used to look only inside folders already expanded). Bounded like
/// Find in Files; skips the same generated folders.
#[tauri::command]
async fn find_files_by_name(folder: String, query: String) -> Result<FileNameSearch, String> {
    // Each keystroke in the filter starts a new walk; the previous one stops.
    let supersede = Supersede::claim(&NAME_SEARCH_GENERATION);
    let _operation_permit = fs_operation_permit().await?;
    let root = authorize_path(&folder)?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || needle.len() > MAX_SEARCH_QUERY_BYTES {
        return Ok(FileNameSearch {
            entries: Vec::new(),
            truncated: false,
        });
    }
    tokio::task::spawn_blocking(move || {
        let mut budget = SearchBudget::new();
        budget.supersede = Some(supersede);
        let mut found = Vec::new();
        find_file_names_recursive(&root, &needle, 0, &mut budget, &mut found);
        let truncated = budget.stopped;
        let mut folders = HashSet::new();
        let mut entries = Vec::new();
        for file in &found {
            let mut parent = file.parent();
            while let Some(folder) = parent {
                if folder == root
                    || !folder.starts_with(&root)
                    || !folders.insert(folder.to_path_buf())
                {
                    break;
                }
                entries.push(FileEntry {
                    name: folder
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    path: clean_path(folder.to_path_buf()),
                    is_directory: true,
                    size: None,
                    modified: None,
                });
                parent = folder.parent();
            }
        }
        for file in found {
            entries.push(FileEntry {
                name: file
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: clean_path(file),
                is_directory: false,
                size: None,
                modified: None,
            });
        }
        FileNameSearch { entries, truncated }
    })
    .await
    .map_err(|e| format!("File name search failed: {e}"))
}

#[derive(Debug, Serialize, Deserialize)]
struct FileMetadata {
    modified: u64,
    size: u64,
    exists: bool,
    identity: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileMetadataWithPath {
    path: String,
    modified: u64,
    size: u64,
    exists: bool,
    identity: String,
}

fn modified_millis(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(unix)]
fn file_identity(_path: &std::path::Path, metadata: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}:{}", metadata.dev(), metadata.ino())
}

// std does not expose by-handle identity (volume serial / file index) on
// stable Rust (see `windows_by_handle_info` above), so this reopens the path
// to read it via `GetFileInformationByHandle` directly.
#[cfg(windows)]
fn file_identity(path: &std::path::Path, _metadata: &fs::Metadata) -> String {
    match windows_path_identity(path, true) {
        Some((volume, index, _)) => format!("{volume}:{index}"),
        None => String::new(),
    }
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &std::path::Path, _metadata: &fs::Metadata) -> String {
    String::new()
}

#[tauri::command]
async fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    let _operation_permit = fs_operation_permit().await?;
    let key = path.clone();
    // Authorization resolves the path too, so it also runs off the runtime.
    let read = start_metadata_read(key, move || {
        let validated_path = match authorize_path(&path) {
            Ok(validated) => validated,
            // The file is gone with its folder: report it as deleted so the
            // watcher shows it, instead of going silent.
            Err(error) if error.starts_with(PARENT_MISSING) => {
                return Ok(FileMetadata {
                    modified: 0,
                    size: 0,
                    exists: false,
                    identity: String::new(),
                })
            }
            Err(error) => return Err(error),
        };
        read_file_metadata(&validated_path)
    });
    let timed_out = || format!("{METADATA_TIMED_OUT}: reading file information took too long");
    let Some(read) = read else {
        return Err(timed_out());
    };
    match tokio::time::timeout(METADATA_TIMEOUT, read).await {
        Ok(result) => result.map_err(|e| format!("Metadata worker failed: {e}"))?,
        Err(_) => Err(timed_out()),
    }
}

/// Paths whose metadata read is still running. Reading metadata blocks in the
/// OS for as long as a network share takes to answer; a path that is still
/// stuck from an earlier poll is skipped instead of tying up another thread.
static METADATA_IN_FLIGHT: OnceLock<std::sync::Mutex<HashSet<String>>> = OnceLock::new();

/// Starts `work` for `key` on a blocking thread, or returns None while an
/// earlier read of the same key is still running.
fn start_metadata_read<T: Send + 'static>(
    key: String,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<tokio::task::JoinHandle<T>> {
    let in_flight = METADATA_IN_FLIGHT.get_or_init(|| std::sync::Mutex::new(HashSet::new()));
    if !in_flight.lock().ok()?.insert(key.clone()) {
        return None;
    }
    Some(tokio::task::spawn_blocking(move || {
        let result = work();
        if let Ok(mut set) = in_flight.lock() {
            set.remove(&key);
        }
        result
    }))
}

fn read_file_metadata(validated_path: &std::path::Path) -> Result<FileMetadata, String> {
    let metadata = match fs::symlink_metadata(validated_path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(_) => return Err("Path is not a regular file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileMetadata {
                modified: 0,
                size: 0,
                exists: false,
                identity: String::new(),
            });
        }
        Err(error) => return Err(format!("Failed to get file metadata: {error}")),
    };

    Ok(FileMetadata {
        modified: modified_millis(&metadata)
            .ok_or_else(|| "Failed to get modification time".to_string())?,
        size: metadata.len(),
        exists: true,
        identity: file_identity(validated_path, &metadata),
    })
}

#[tauri::command]
async fn get_files_metadata(paths: Vec<String>) -> Result<Vec<FileMetadataWithPath>, String> {
    let _operation_permit = fs_operation_permit().await?;
    if paths.len() > MAX_METADATA_BATCH {
        return Err(format!(
            "Metadata batch exceeds the {MAX_METADATA_BATCH}-path limit"
        ));
    }

    // Each path is read on its own blocking thread, all against one deadline.
    // A path on a share that doesn't answer is left out of
    // this poll (the watcher tries it again later); the other files are
    // still checked, instead of one slow file holding up all of them.
    let deadline = tokio::time::Instant::now() + METADATA_TIMEOUT;
    let reads: Vec<_> = paths
        .into_iter()
        .filter_map(|path| start_metadata_read(path.clone(), move || poll_file_metadata(path)))
        .collect();
    let mut results = Vec::new();
    for read in reads {
        if let Ok(Ok(Some(entry))) = tokio::time::timeout_at(deadline, read).await {
            results.push(entry);
        }
    }
    Ok(results)
}

const METADATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const METADATA_TIMED_OUT: &str = "ZITEXT_METADATA_TIMEOUT";

/// One watcher sample. None: the path is not authorized, or a transient
/// error (not a deletion) occurred; the watcher simply tries again later.
fn poll_file_metadata(path: String) -> Option<FileMetadataWithPath> {
    let missing = |path: String| FileMetadataWithPath {
        path,
        modified: 0,
        size: 0,
        exists: false,
        identity: String::new(),
    };
    let validated_path = match authorize_path(&path) {
        Ok(validated) => validated,
        // Gone with its folder: report it as deleted (see get_file_metadata).
        Err(error) if error.starts_with(PARENT_MISSING) => return Some(missing(path)),
        Err(_) => return None,
    };
    match fs::symlink_metadata(&validated_path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            modified_millis(&metadata).map(|modified| FileMetadataWithPath {
                identity: file_identity(&validated_path, &metadata),
                path,
                modified,
                size: metadata.len(),
                exists: true,
            })
        }
        Ok(_) => Some(missing(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(missing(path)),
        Err(_error) => {
            dlog!("Failed to poll metadata for {}: {}", path, _error);
            None
        }
    }
}

#[tauri::command]
async fn rebuild_native_menu(app: tauri::AppHandle) -> Result<(), String> {
    let settings = load_settings(app.clone()).await?;
    let recent_files = existing_recent_files(settings.recent_files).await;
    let menu = build_app_menu(&app, recent_files, &settings.keybindings)
        .map_err(|e| format!("Failed to build menu: {}", e))?;
    app.set_menu(menu)
        .map_err(|e| format!("Failed to set menu: {}", e))?;
    Ok(())
}

/// True when `new` is `old` with only its letter case changed, on a volume
/// that treats the two names as the same file (default APFS and NTFS).
fn is_case_only_rename(old: &std::path::Path, new: &std::path::Path) -> bool {
    let (Some(old_name), Some(new_name)) = (old.file_name(), new.file_name()) else {
        return false;
    };
    if old.parent() != new.parent()
        || old_name == new_name
        || old_name.to_string_lossy().to_lowercase() != new_name.to_string_lossy().to_lowercase()
    {
        return false;
    }
    let (Ok(old_meta), Ok(new_meta)) = (fs::metadata(old), fs::metadata(new)) else {
        return false;
    };
    let old_id = file_identity(old, &old_meta);
    !old_id.is_empty() && old_id == file_identity(new, &new_meta)
}

/// macOS: rename that fails if the destination exists (RENAME_EXCL).
#[cfg(target_os = "macos")]
fn rename_no_replace(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let to_c = |p: &std::path::Path| {
        std::ffi::CString::new(p.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    };
    let (old_c, new_c) = (to_c(old)?, to_c(new)?);
    // SAFETY: both arguments are valid NUL-terminated paths.
    if unsafe { libc::renamex_np(old_c.as_ptr(), new_c.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Elsewhere: hard_link creates the destination with no-replace semantics;
/// removing the old link completes the rename. A crash in between can leave
/// two names but cannot destroy either file. Filesystems without hard links
/// (FAT, exFAT, many SMB shares) fall back to a plain rename after checking
/// that the destination does not exist.
#[cfg(not(target_os = "macos"))]
fn rename_no_replace(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    match fs::hard_link(old, new) {
        Ok(()) => {
            if let Err(error) = fs::remove_file(old) {
                let _ = fs::remove_file(new);
                return Err(error);
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
        Err(error) => match fs::symlink_metadata(new) {
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => fs::rename(old, new),
            _ => Err(error),
        },
    }
}

fn rename_file_sync(old: &std::path::Path, new: &std::path::Path) -> Result<(), String> {
    if !old.is_file() {
        return Err("Only regular files can be renamed".to_string());
    }
    if is_case_only_rename(old, new) {
        return fs::rename(old, new).map_err(|e| format!("Failed to rename the file: {e}"));
    }
    rename_no_replace(old, new).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "A file with that name already exists.".to_string()
        } else {
            format!("Failed to rename the file without overwriting the destination; use Save As if needed: {e}")
        }
    })
}

/// Checks a new file name typed by the user: one path component that every
/// supported platform can store (on Windows also its reserved characters and
/// device names).
fn validate_file_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." {
        return Err("Enter a file name.".to_string());
    }
    if name.len() > 255 {
        return Err("That file name is too long.".to_string());
    }
    if name.contains(['/', '\\', '\0']) {
        return Err("A file name can't contain / or \\.".to_string());
    }
    if cfg!(windows) {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.chars().any(char::is_control)
        {
            return Err("A file name can't contain any of < > : \" | ? *".to_string());
        }
        if name.ends_with(['.', ' ']) {
            return Err("A file name can't end with a dot or a space.".to_string());
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit());
        if reserved {
            return Err(format!("{stem} is a reserved name on Windows."));
        }
    }
    Ok(())
}

/// Resolves a rename request to its target. Renames stay within the file's
/// folder, and the target keeps the letter case the user typed: resolving
/// the whole path would fold `README.md` back to an existing `readme.md`.
fn rename_target(validated_old: &std::path::Path, new_path: &str) -> Result<PathBuf, String> {
    let requested = std::path::Path::new(new_path);
    let name = requested
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Enter a file name.".to_string())?;
    validate_file_name(name)?;
    // Both sides in ordinary form: on Windows canonicalize() returns verbatim
    // paths (\\?\C:\...) while canonical_form() strips that prefix, so
    // comparing them as-is rejected every rename.
    let folder = validated_old
        .parent()
        .map(|parent| strip_unc_prefix(parent.to_path_buf()))
        .ok_or_else(|| "The file has no parent folder".to_string())?;
    let requested_folder = requested
        .parent()
        .and_then(canonical_form)
        .ok_or_else(|| "A file can only be renamed within its folder".to_string())?;
    if requested_folder != folder {
        return Err("A file can only be renamed within its folder".to_string());
    }
    Ok(folder.join(name))
}

#[tauri::command]
async fn rename_file(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let validated_old = authorize_path(&old_path)?;
    let target = rename_target(&validated_old, &new_path)?;
    // A file opened on its own (not through a folder) has a grant for its
    // own path only. The user confirms the new name natively, which grants
    // exactly that sibling; a renderer can't authorize paths by itself.
    // Authorize the path that will actually be renamed to, not the string the
    // renderer sent (they differ if it reaches the folder another way).
    if authorize_path(&target.to_string_lossy()).is_err() {
        let old_name = validated_old
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let new_name = target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(format!("Rename \"{old_name}\" to \"{new_name}\"?"))
            .title("Rename File")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Rename".to_string(),
                "Cancel".to_string(),
            ))
            .show(move |confirmed| {
                let _ = sender.send(confirmed);
            });
        if !receiver.await.unwrap_or(false) {
            return Ok(false);
        }
    }

    // A rename changes files like a save does, so it shares the write lock
    // rather than the general permit that searches and polling can exhaust.
    let _write_guard = FILE_WRITE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    rename_file_sync(&validated_old, &target)?;
    // Transfer any explicit file-grant on the old path to the new path so
    // subsequent reads/writes against the renamed file keep working.
    revoke_file_grant(&validated_old);
    grant_file(&target);
    retarget_wait_locks(&clean_path(validated_old), &clean_path(target));
    Ok(true)
}

/// Converts a binding as the shortcut editor stores it ("Cmd+Shift+S",
/// "Ctrl+Alt+F", "Alt+Z") into a menu accelerator ("CmdOrCtrl+Shift+S").
/// None for keys a menu accelerator can't name.
fn menu_accelerator(binding: &str) -> Option<String> {
    let mut parts = Vec::new();
    let mut key = None;
    for part in binding.split('+').filter(|part| !part.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "ctrl" | "meta" => parts.push("CmdOrCtrl".to_string()),
            "alt" | "option" => parts.push("Alt".to_string()),
            "shift" => parts.push("Shift".to_string()),
            name => {
                let named = match name {
                    "space" => Some("Space".to_string()),
                    "arrowup" => Some("Up".to_string()),
                    "arrowdown" => Some("Down".to_string()),
                    "arrowleft" => Some("Left".to_string()),
                    "arrowright" => Some("Right".to_string()),
                    "enter" => Some("Enter".to_string()),
                    "tab" => Some("Tab".to_string()),
                    "home" | "end" | "pageup" | "pagedown" | "delete" | "backspace" => {
                        let mut chars = name.chars();
                        chars
                            .next()
                            .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                    }
                    _ if name.len() == 1 && name.chars().all(|c| c.is_ascii_alphanumeric()) => {
                        Some(name.to_ascii_uppercase())
                    }
                    _ if name.starts_with('f')
                        && name[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) =>
                    {
                        Some(name.to_ascii_uppercase())
                    }
                    _ => None,
                };
                key = Some(named?);
            }
        }
    }
    parts.push(key?);
    Some(parts.join("+"))
}

/// Builds the native app menu — used on all desktop platforms so file dialogs
/// can be triggered via real menu/keyboard gestures rather than purely from
/// the renderer. The menu is the canonical entry point; `request_menu_action`
/// (the only renderer-callable dialog command) routes through the same logic.
fn build_app_menu(
    handle: &tauri::AppHandle,
    recent_files: Vec<String>,
    keybindings: &HashMap<String, String>,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    // Menu items for the commands in Settings > Keyboard Shortcuts show and
    // answer to the user's own key, like the rest of the app.
    // A binding the menu can't express keeps the default.
    let shortcut_item = |id: &str, label: &str, command: &str, default: Option<&str>| {
        if let Some(custom) = keybindings
            .get(command)
            .and_then(|binding| menu_accelerator(binding))
        {
            if let Ok(item) = MenuItem::with_id(handle, id, label, true, Some(custom.as_str())) {
                return Ok(item);
            }
        }
        MenuItem::with_id(handle, id, label, true, default)
    };

    // Standard App Menu. On macOS it holds the usual items; Quit is a custom
    // item so it goes through the unsaved-changes flow (request_app_close).
    let app_menu = Submenu::with_id(handle, "app", "ZITEXT", true)?;
    #[cfg(target_os = "macos")]
    {
        app_menu.append(&MenuItem::with_id(
            handle,
            "about",
            "About ZITEXT Editor",
            true,
            None::<&str>,
        )?)?;
        app_menu.append(&PredefinedMenuItem::separator(handle)?)?;
        app_menu.append(&PredefinedMenuItem::services(handle, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(handle)?)?;
        app_menu.append(&PredefinedMenuItem::hide(handle, None)?)?;
        app_menu.append(&PredefinedMenuItem::hide_others(handle, None)?)?;
        app_menu.append(&PredefinedMenuItem::show_all(handle, None)?)?;
        app_menu.append(&PredefinedMenuItem::separator(handle)?)?;
        app_menu.append(&MenuItem::with_id(
            handle,
            "quit",
            "Quit ZITEXT",
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }

    // File Menu
    let file_menu = Submenu::with_id(handle, "file", "File", true)?;
    let m_new = shortcut_item("new", "New", "new", Some("CmdOrCtrl+N"))?;
    let m_open = shortcut_item("open", "Open File...", "open", Some("CmdOrCtrl+O"))?;
    // No default key: Cmd+K here would swallow Monaco's Cmd+K chords.
    let m_open_folder = shortcut_item("open_folder", "Open Folder...", "openFolder", None)?;

    let m_open_large = MenuItem::with_id(
        handle,
        "open_large_file",
        "Open Large File or Log...",
        true,
        None::<&str>,
    )?;

    file_menu.append(&m_new)?;
    file_menu.append(&m_open)?;
    file_menu.append(&m_open_folder)?;
    file_menu.append(&m_open_large)?;
    file_menu.append(&PredefinedMenuItem::separator(handle)?)?;

    // Recent Files Submenu
    if !recent_files.is_empty() {
        let recent_menu = Submenu::with_id(handle, "recent", "Recent Files", true)?;

        // Show up to 10 files (matching current system limit)
        let display_count = recent_files.len().min(10);
        for file_path in recent_files.iter().take(display_count) {
            // Extract filename from full path
            let file_name = std::path::Path::new(file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(file_path);

            // Create menu item with unique ID
            let menu_id = format!("recent:{}", file_path);
            let m_recent = MenuItem::with_id(handle, &menu_id, file_name, true, None::<&str>)?;
            recent_menu.append(&m_recent)?;
        }

        file_menu.append(&recent_menu)?;
        file_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    }

    let m_save = shortcut_item("save", "Save", "save", Some("CmdOrCtrl+S"))?;
    let m_save_as = shortcut_item("save_as", "Save As...", "saveAs", Some("CmdOrCtrl+Shift+S"))?;
    let m_revert = MenuItem::with_id(handle, "revert_file", "Revert File", true, None::<&str>)?;
    let m_close = shortcut_item("close", "Close Tab", "close", Some("CmdOrCtrl+W"))?;

    file_menu.append(&m_save)?;
    file_menu.append(&m_save_as)?;
    file_menu.append(&m_revert)?;
    let compare_menu = Submenu::with_id(handle, "compare", "Compare", true)?;
    for (id, label) in [
        ("compare_file", "With File..."),
        ("compare_tab", "With Open Tab..."),
        ("compare_clipboard", "With Clipboard"),
        ("compare_saved", "With Saved Version"),
    ] {
        compare_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    file_menu.append(&compare_menu)?;
    file_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    file_menu.append(&m_close)?;

    // Edit Menu
    let edit_menu = Submenu::with_id(handle, "edit", "Edit", true)?;
    edit_menu.append(&PredefinedMenuItem::undo(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::redo(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    edit_menu.append(&PredefinedMenuItem::cut(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::copy(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::paste(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::select_all(handle, None)?)?;
    edit_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    let m_find = shortcut_item("find", "Find...", "find", Some("CmdOrCtrl+F"))?;
    let m_replace = shortcut_item(
        "replace",
        "Find & Replace...",
        "replace",
        // Cmd+H is Hide on macOS.
        Some(if cfg!(target_os = "macos") {
            "CmdOrCtrl+Alt+F"
        } else {
            "CmdOrCtrl+H"
        }),
    )?;
    let m_find_in_files = MenuItem::with_id(
        handle,
        "find_in_files",
        "Find in Files...",
        true,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let m_goto = shortcut_item("goto", "Go to Line...", "goToLine", Some("CmdOrCtrl+G"))?;
    // Monaco's own binding is Shift+Option+F on macOS; "Alt" maps to Option there.
    // Matches the in-app menubar on Windows/Linux.
    let m_format = MenuItem::with_id(
        handle,
        "format_document",
        "Format Document",
        true,
        Some("Shift+Alt+F"),
    )?;
    edit_menu.append(&m_find)?;
    edit_menu.append(&m_replace)?;
    edit_menu.append(&m_find_in_files)?;
    edit_menu.append(&m_goto)?;
    edit_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    edit_menu.append(&m_format)?;

    // View Menu
    let view_menu = Submenu::with_id(handle, "view", "View", true)?;
    let m_theme = MenuItem::with_id(
        handle,
        "toggle_theme",
        "Toggle Theme (Dark/Light)",
        true,
        None::<&str>,
    )?;
    let m_wrap = shortcut_item("toggle_wrap", "Toggle Word Wrap", "wordWrap", None)?;
    let m_read_only = MenuItem::with_id(
        handle,
        "toggle_read_only",
        "Toggle Read-Only",
        true,
        None::<&str>,
    )?;
    let m_explorer = MenuItem::with_id(
        handle,
        "toggle_explorer",
        "Toggle Explorer",
        true,
        None::<&str>,
    )?;
    let m_preview = MenuItem::with_id(
        handle,
        "toggle_preview",
        "Toggle Markdown Preview",
        true,
        Some("CmdOrCtrl+Shift+V"),
    )?;
    let m_copy_path = MenuItem::with_id(handle, "copy_path", "Copy File Path", true, None::<&str>)?;
    let m_split = MenuItem::with_id(
        handle,
        "toggle_split",
        "Toggle Split View",
        true,
        Some("CmdOrCtrl+\\"),
    )?;
    let m_open_right = MenuItem::with_id(
        handle,
        "open_right_pane",
        "Open in Right Pane",
        true,
        None::<&str>,
    )?;
    let m_swap = MenuItem::with_id(handle, "swap_panes", "Swap Panes", true, None::<&str>)?;

    view_menu.append(&m_theme)?;
    view_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    view_menu.append(&m_wrap)?;
    // Grouped with Word Wrap to match the in-app menubar on Windows/Linux.
    view_menu.append(&m_read_only)?;
    view_menu.append(&m_explorer)?;
    view_menu.append(&m_preview)?;
    view_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    view_menu.append(&m_split)?;
    view_menu.append(&m_open_right)?;
    view_menu.append(&m_swap)?;
    view_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    view_menu.append(&m_copy_path)?;
    view_menu.append(&PredefinedMenuItem::separator(handle)?)?;

    // Language Submenu
    let lang_menu = Submenu::with_id(handle, "language", "Language", true)?;

    // Web and Markup Category
    let web_menu = Submenu::with_id(handle, "lang_web", "Web and Markup", true)?;
    let web_langs = [
        ("lang-html", "HTML"),
        ("lang-css", "CSS"),
        ("lang-javascript", "JavaScript"),
        ("lang-typescript", "TypeScript"),
        ("lang-php", "PHP"),
        ("lang-scss", "SCSS"),
        ("lang-less", "Less"),
        ("lang-coffeescript", "CoffeeScript"),
        ("lang-handlebars", "Handlebars"),
        ("lang-pug", "Pug"),
        ("lang-razor", "Razor"),
        ("lang-twig", "Twig"),
        ("lang-markdown", "Markdown"),
        ("lang-mdx", "MDX"),
        ("lang-restructuredtext", "reStructuredText"),
        ("lang-liquid", "Liquid"),
        ("lang-freemarker2", "FreeMarker"),
    ];
    for (id, label) in web_langs {
        web_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    lang_menu.append(&web_menu)?;

    // General Programming Category
    let gen_menu = Submenu::with_id(handle, "lang_gen", "General Programming", true)?;
    let gen_langs = [
        ("lang-python", "Python"),
        ("lang-java", "Java"),
        ("lang-csharp", "C#"),
        ("lang-go", "Go"),
        ("lang-ruby", "Ruby"),
        ("lang-swift", "Swift"),
        ("lang-kotlin", "Kotlin"),
        ("lang-dart", "Dart"),
        ("lang-elixir", "Elixir"),
        ("lang-clojure", "Clojure"),
        ("lang-julia", "Julia"),
        ("lang-lua", "Lua"),
        ("lang-perl", "Perl"),
        ("lang-r", "R"),
        ("lang-scala", "Scala"),
        ("lang-scheme", "Scheme"),
        ("lang-fsharp", "F#"),
        ("lang-vb", "Visual Basic"),
        ("lang-tcl", "Tcl"),
        ("lang-apex", "Apex"),
        ("lang-abap", "ABAP"),
        ("lang-qsharp", "Q#"),
        ("lang-m3", "Modula-3"),
        ("lang-sb", "Small Basic"),
        ("lang-postiats", "ATS"),
        ("lang-ecl", "ECL"),
        ("lang-flow9", "Flow9"),
        ("lang-cameligo", "CameLIGO"),
        ("lang-pascaligo", "PascaLIGO"),
        ("lang-lexon", "Lexon"),
        ("lang-aes", "AES (Sophia)"),
    ];
    for (id, label) in gen_langs {
        gen_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    lang_menu.append(&gen_menu)?;

    // Systems and Engineering Category
    let sys_menu = Submenu::with_id(handle, "lang_sys", "Systems and Engineering", true)?;
    let sys_langs = [
        ("lang-c", "C"),
        ("lang-cpp", "C++"),
        ("lang-rust", "Rust"),
        ("lang-objective-c", "Objective-C"),
        ("lang-pascal", "Pascal"),
        ("lang-verilog", "Verilog"),
        ("lang-sol", "Solidity"),
        ("lang-systemverilog", "SystemVerilog"),
        ("lang-mips", "MIPS Assembly"),
        ("lang-wgsl", "WGSL"),
        ("lang-st", "Structured Text"),
    ];
    for (id, label) in sys_langs {
        sys_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    lang_menu.append(&sys_menu)?;

    // Data and Config Category
    let data_menu = Submenu::with_id(handle, "lang_data", "Data and Config", true)?;
    let data_langs = [
        ("lang-json", "JSON"),
        ("lang-xml", "XML"),
        ("lang-yaml", "YAML"),
        ("lang-toml", "TOML"),
        ("lang-ini", "INI"),
        ("lang-sql", "SQL"),
        ("lang-graphql", "GraphQL"),
        ("lang-redis", "Redis"),
        ("lang-mysql", "MySQL"),
        ("lang-pgsql", "PostgreSQL"),
        ("lang-redshift", "Redshift"),
        ("lang-sparql", "SPARQL"),
        ("lang-cypher", "Cypher"),
        ("lang-msdax", "DAX"),
        ("lang-powerquery", "Power Query"),
        ("lang-proto", "Protocol Buffers"),
        ("lang-hcl", "Terraform (HCL)"),
        ("lang-bicep", "Bicep"),
        ("lang-typespec", "TypeSpec"),
        ("lang-csp", "Content Security Policy"),
    ];
    for (id, label) in data_langs {
        data_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    lang_menu.append(&data_menu)?;

    // Scripts and Build Category
    let script_menu = Submenu::with_id(handle, "lang_script", "Scripts and Build", true)?;
    let script_langs = [
        ("lang-shell", "Shell"),
        ("lang-powershell", "PowerShell"),
        ("lang-bat", "Batch"),
        ("lang-dockerfile", "Dockerfile"),
        ("lang-azcli", "Azure CLI"),
        ("lang-pla", "PLA"),
        ("lang-makefile", "Makefile"),
        ("lang-plaintext", "Plain Text"),
    ];
    for (id, label) in script_langs {
        script_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    lang_menu.append(&script_menu)?;

    // Settings Menu
    let settings_menu = Submenu::with_id(handle, "settings", "Settings", true)?;
    let m_prefs = MenuItem::with_id(
        handle,
        "preferences",
        "Preferences...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let m_keys = MenuItem::with_id(
        handle,
        "shortcuts",
        "Keyboard Shortcuts...",
        true,
        None::<&str>,
    )?;
    settings_menu.append(&m_prefs)?;
    settings_menu.append(&m_keys)?;

    // Tools Menu: Scratchpad, Text and Data Tools (the full list is in the
    // command palette), marks.
    let tools_menu = Submenu::with_id(handle, "tools", "Tools", true)?;
    tools_menu.append(&shortcut_item(
        "scratchpad",
        "Open Scratchpad",
        "scratchpad",
        Some("CmdOrCtrl+Shift+N"),
    )?)?;
    tools_menu.append(&MenuItem::with_id(
        handle,
        "text_tools",
        "Text and Data Tools...",
        true,
        None::<&str>,
    )?)?;
    tools_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    tools_menu.append(&shortcut_item(
        "mark_selection",
        "Mark Selection",
        "markSelection",
        Some("CmdOrCtrl+Shift+M"),
    )?)?;
    for (id, label) in [
        ("mark_find", "Mark Find Matches"),
        ("mark_text", "Mark Text..."),
        ("mark_regex", "Mark Regular Expression..."),
    ] {
        tools_menu.append(&MenuItem::with_id(handle, id, label, true, None::<&str>)?)?;
    }
    tools_menu.append(&shortcut_item(
        "next_mark",
        "Next Marked",
        "nextMark",
        Some("F4"),
    )?)?;
    tools_menu.append(&shortcut_item(
        "previous_mark",
        "Previous Marked",
        "previousMark",
        Some("Shift+F4"),
    )?)?;
    tools_menu.append(&MenuItem::with_id(
        handle,
        "clear_marks",
        "Clear All Marks",
        true,
        None::<&str>,
    )?)?;

    // Help Menu
    let help_menu = Submenu::with_id(handle, "help", "Help", true)?;
    let m_about = MenuItem::with_id(handle, "about", "About ZITEXT Editor", true, None::<&str>)?;
    help_menu.append(&m_about)?;

    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &tools_menu,
            &lang_menu,
            &settings_menu,
            &help_menu,
        ],
    )?;
    // macOS Window menu: Minimize (Cmd+M) and Zoom. (AppKit adds Enter Full
    // Screen to the View menu by itself.)
    #[cfg(target_os = "macos")]
    {
        let window_menu = Submenu::with_id(handle, "window", "Window", true)?;
        window_menu.append(&PredefinedMenuItem::minimize(handle, None)?)?;
        window_menu.append(&PredefinedMenuItem::maximize(handle, Some("Zoom"))?)?;
        menu.insert(&window_menu, 7)?;
        // Lets AppKit add the window list and Bring All to Front.
        window_menu.set_as_windows_menu_for_nsapp()?;
    }

    Ok(menu)
}

// ============================================================================
// Find in Files commands
// ============================================================================

/// A search's matches plus what it could not cover, so "no results" is never
/// shown for a search that did not finish.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchReport {
    matches: Vec<FileSearchMatch>,
    /// The result cap was reached; more matches may exist.
    result_limit_reached: bool,
    /// The time, file-count or response-size budget stopped the walk.
    stopped_early: bool,
    skipped_large_files: u32,
    skipped_encoding_files: u32,
    skipped_deep_folders: u32,
    skipped_links: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileSearchMatch {
    file_path: String,
    line_number: u32,
    line_content: String,
    match_start: u32,
    match_end: u32,
}

// Extensions that are essentially never valid UTF-8 text, skipped up front
// purely to avoid opening/reading them. This is a performance shortcut, not
// the correctness check — `search_file` already caps file size and validates
// UTF-8 before searching, so a plain-text file with an unusual or missing
// extension (a README with no extension, "Dockerfile.dev", a file named just
// "90") is still searched instead of being silently skipped for not matching
// a curated allow-list of "known" text extensions.
const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "avif", "heic", "mp3", "mp4",
    "wav", "avi", "mov", "mkv", "flac", "ogg", "webm", "m4a", "m4v", "zip", "tar", "gz", "tgz",
    "7z", "rar", "bz2", "xz", "zst", "exe", "dll", "so", "dylib", "bin", "obj", "o", "a", "lib",
    "class", "pyc", "pyd", "wasm", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "ttf",
    "otf", "woff", "woff2", "eot", "db", "sqlite", "sqlite3", "pdb", "iso", "img", "dmg", "node",
];

fn is_text_file(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    !BINARY_EXTENSIONS.contains(&ext.as_str())
}

struct SearchOptions<'a> {
    query: &'a str,
    case_sensitive: bool,
    whole_word: bool,
    max_results: usize,
}

fn search_file(
    path: &std::path::Path,
    options: &SearchOptions<'_>,
    results: &mut Vec<FileSearchMatch>,
    budget: &mut SearchBudget,
) {
    if !budget.check() {
        return;
    }
    budget.files_visited += 1;

    // Open and inspect through one no-follow handle; directory entries can be
    // replaced concurrently in shared workspaces.
    let file = match open_regular_file(path) {
        Ok((file, metadata)) if metadata.len() <= LARGE_FILE_WARNING => file,
        Ok(_) => {
            budget.skipped_large += 1;
            return;
        }
        Err(_) => return,
    };
    let Ok(bytes) = read_bounded(file) else {
        return;
    };
    // Same decoding as opening the file: UTF-8 (with or without BOM) or
    // Windows-1252. Binary and UTF-16 files are skipped and counted.
    let check_len = bytes.len().min(8192);
    if bytes[..check_len].contains(&0u8)
        && !bytes.starts_with(&[0xFF, 0xFE])
        && !bytes.starts_with(&[0xFE, 0xFF])
    {
        return;
    }
    let content = match decode_text(&bytes) {
        Ok((content, _)) => content,
        Err(_) => {
            budget.skipped_encoding += 1;
            return;
        }
    };

    // Lower-cased character by character, exactly like each line below:
    // str::to_lowercase maps a word-final Σ to ς, char::to_lowercase to σ.
    let needle = if options.case_sensitive {
        options.query.to_string()
    } else {
        options.query.chars().flat_map(char::to_lowercase).collect()
    };

    for (line_idx, line) in editor_lines(&content).enumerate() {
        if results.len() >= options.max_results {
            break;
        }

        // Case-insensitive search runs on a lower-cased copy. Lower-casing can
        // change a character's length ("İ" becomes two characters), so keep,
        // for every byte of the copy, the index of the original character it
        // came from; match positions are mapped back through it.
        let (haystack, origin_char): (std::borrow::Cow<'_, str>, Option<Vec<usize>>) =
            if options.case_sensitive {
                (std::borrow::Cow::Borrowed(line), None)
            } else {
                let mut lowered = String::with_capacity(line.len());
                let mut origin = Vec::with_capacity(line.len());
                for (index, character) in line.chars().enumerate() {
                    let before = lowered.len();
                    lowered.extend(character.to_lowercase());
                    origin.extend(std::iter::repeat_n(index, lowered.len() - before));
                }
                (std::borrow::Cow::Owned(lowered), Some(origin))
            };
        let original_chars = || line.chars();

        let mut search_start = 0;
        while search_start < haystack.len() {
            if results.len() >= options.max_results {
                break;
            }

            match haystack[search_start..].find(needle.as_str()) {
                None => break,
                Some(rel) => {
                    let abs_start = search_start + rel;
                    let abs_end = abs_start + needle.len();

                    // Positions of the match in the original line, in characters.
                    let (char_start, char_end) = match &origin_char {
                        None => (
                            haystack[..abs_start].chars().count(),
                            haystack[..abs_end].chars().count(),
                        ),
                        Some(origin) => (
                            origin[abs_start],
                            origin[abs_end.saturating_sub(1).max(abs_start)] + 1,
                        ),
                    };
                    let is_word = |c: char| c.is_alphanumeric() || c == '_';
                    let ok = !options.whole_word
                        || ((char_start == 0
                            || !original_chars().nth(char_start - 1).is_some_and(is_word))
                            && !original_chars().nth(char_end).is_some_and(is_word));

                    if ok {
                        // Convert character offsets in the original `line` to
                        // UTF-16 code units: JavaScript strings are UTF-16, so
                        // `.slice(start, end)` needs UTF-16 indices.
                        // 2. Walk the original line to the same char positions and
                        //    accumulate UTF-16 code units (BMP chars = 1, others = 2).
                        // Bound the preview returned over IPC while retaining
                        // the match and useful context on very long lines.
                        let preview_start_char = char_start.saturating_sub(512);
                        let mut preview = String::new();
                        for character in line.chars().skip(preview_start_char) {
                            if preview.len() + character.len_utf8() > MAX_SEARCH_PREVIEW_BYTES {
                                break;
                            }
                            preview.push(character);
                        }

                        let local_char_start = char_start.saturating_sub(preview_start_char);
                        let local_char_end = char_end.saturating_sub(preview_start_char);
                        let utf16_start = preview
                            .chars()
                            .take(local_char_start)
                            .fold(0u32, |n, c| n + c.len_utf16() as u32);
                        let utf16_end = preview
                            .chars()
                            .take(local_char_end)
                            .fold(0u32, |n, c| n + c.len_utf16() as u32);

                        let result_bytes = path.as_os_str().len() + preview.len();
                        if budget.response_bytes.saturating_add(result_bytes)
                            > MAX_SEARCH_RESPONSE_BYTES
                        {
                            budget.stopped = true;
                            return;
                        }
                        budget.response_bytes += result_bytes;
                        results.push(FileSearchMatch {
                            file_path: clean_path(path.to_path_buf()),
                            line_number: (line_idx + 1) as u32,
                            line_content: preview,
                            match_start: utf16_start,
                            match_end: utf16_end,
                        });
                    }

                    // Advance by at least one byte to avoid infinite loop on empty needle.
                    search_start = abs_end.max(abs_start + 1);
                }
            }
        }
    }
}

/// Splits text into lines the way the editor does: at CRLF, LF and a lone CR,
/// so Find in Files line numbers match the editor (str::lines ignores CR).
fn editor_lines(text: &str) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        match rest.find(['\r', '\n']) {
            Some(index) => {
                let line = &rest[..index];
                let skip = if rest[index..].starts_with("\r\n") {
                    2
                } else {
                    1
                };
                rest = &rest[index + skip..];
                Some(line)
            }
            None => {
                let line = rest;
                rest = "";
                Some(line)
            }
        }
    })
}

/// Well-known large or generated directories: build output, caches, VCS data,
/// installed dependencies. Their contents are machine-generated rather than
/// part of the project, so both the find-in-files walk and the explorer's file
/// count skip them — shared here so the two can't drift apart and report
/// different ideas of what the project contains.
fn is_generated_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".git"
            | "__pycache__"
            | ".venv"
            | "vendor"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".turbo"
            | ".angular"
            | ".vite"
            | ".parcel-cache"
            | ".cache"
            | ".output"
            | "coverage"
    )
}

fn search_dir_recursive(
    dir: &std::path::Path,
    options: &SearchOptions<'_>,
    results: &mut Vec<FileSearchMatch>,
    depth: usize,
    budget: &mut SearchBudget,
) {
    if depth > MAX_DIRECTORY_DEPTH {
        budget.skipped_deep += 1;
        return;
    }
    if results.len() >= options.max_results || !budget.check() {
        return;
    }

    match fs::symlink_metadata(dir) {
        Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {}
        _ => return,
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if results.len() >= options.max_results || !budget.check() {
            break;
        }

        let path = entry.path();

        // Skip symlinks — prevents following crafted symlinks outside the
        // search root. Counted for the "not searched" note.
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                budget.skipped_links += 1;
                continue;
            }
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Do not skip dotfiles — .bashrc, .gitignore, .env, etc. are valid search targets.
        // Specific large/binary dot-directories (.git, .venv, …) are excluded below.

        if metadata.file_type().is_dir() {
            // Skip well-known large or generated directories (build output, caches, VCS
            // data, etc.). These hold machine-generated files that would otherwise flood
            // results and exhaust the match cap / visit budget before real source files
            // are reached — e.g. a Next.js `.next` folder buried product-icons.tsx entirely.
            if is_generated_dir(name) {
                continue;
            }
            search_dir_recursive(&path, options, results, depth + 1, budget);
        } else if metadata.file_type().is_file() && is_text_file(&path) {
            search_file(&path, options, results, budget);
        }
    }
}

/// Upper bound on the explorer's file count. A project past this is reported as
/// the cap rather than walked to the end, so opening a huge tree can't stall.
const MAX_COUNTED_FILES: usize = 100_000;

/// Stops a file count that a newer count replaced or that ran too long.
struct CountBudget {
    supersede: Supersede,
    deadline: std::time::Instant,
}

impl CountBudget {
    fn exhausted(&self) -> bool {
        self.supersede.superseded() || std::time::Instant::now() >= self.deadline
    }
}

/// The explorer footer's figure. `partial` is set when counting stopped at a
/// limit (time, file count or folder depth), so the footer can say "or more".
#[derive(Debug, Default, Serialize)]
struct FileCount {
    count: usize,
    partial: bool,
}

fn count_files_recursive(
    dir: &std::path::Path,
    depth: usize,
    total: &mut FileCount,
    budget: &CountBudget,
) {
    if depth > MAX_DIRECTORY_DEPTH || total.count >= MAX_COUNTED_FILES || budget.exhausted() {
        total.partial = true;
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return; // Unreadable subtree (permissions, race) — count what we can.
    };
    for entry in entries.flatten() {
        if total.count >= MAX_COUNTED_FILES || budget.exhausted() {
            total.partial = true;
            return;
        }
        let path = entry.path();
        // Symlinks are not followed: a cycle would otherwise count forever.
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if is_generated_dir(name) {
                continue;
            }
            count_files_recursive(&path, depth + 1, total, budget);
        } else if metadata.is_file() {
            total.count += 1;
        }
    }
}

/// Total files in the opened folder, for the explorer footer.
///
/// Counts the whole tree rather than the part the user has expanded: the figure
/// describes the project, so it must not change as folders are opened. Skips
/// the generated directories above, so `node_modules` doesn't turn a 200-file
/// project into a 40,000-file one.
#[tauri::command]
async fn count_project_files(path: String) -> Result<FileCount, String> {
    let supersede = Supersede::claim(&COUNT_GENERATION);
    let _operation_permit = fs_operation_permit().await?;
    let validated_path = authorize_path(&path)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut total = FileCount::default();
        let budget = CountBudget {
            supersede,
            deadline: std::time::Instant::now() + MAX_SEARCH_DURATION,
        };
        count_files_recursive(&validated_path, 0, &mut total, &budget);
        total
    })
    .await
    .map_err(|e| format!("Failed to count files: {e}"))
}

fn search_report(matches: Vec<FileSearchMatch>, budget: &SearchBudget) -> FileSearchReport {
    FileSearchReport {
        result_limit_reached: matches.len() >= MAX_SEARCH_RESULTS,
        matches,
        stopped_early: budget.stopped,
        skipped_large_files: budget.skipped_large,
        skipped_encoding_files: budget.skipped_encoding,
        skipped_deep_folders: budget.skipped_deep,
        skipped_links: budget.skipped_links,
    }
}

#[tauri::command]
async fn search_in_files(
    folder: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<FileSearchReport, String> {
    // A new search supersedes any still running; claimed before waiting for
    // a permit, so the old search stops and releases its permit sooner.
    let supersede = Supersede::claim(&SEARCH_GENERATION);
    let _operation_permit = fs_operation_permit().await?;
    if query.is_empty() {
        return Ok(search_report(Vec::new(), &SearchBudget::new()));
    }
    if query.len() > MAX_SEARCH_QUERY_BYTES {
        return Err(format!(
            "Search query exceeds the {MAX_SEARCH_QUERY_BYTES}-byte limit"
        ));
    }

    let validated_folder = authorize_path(&folder)?;
    if !validated_folder.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let mut budget = SearchBudget::new();
        budget.supersede = Some(supersede);
        let options = SearchOptions {
            query: &query,
            case_sensitive,
            whole_word,
            max_results: MAX_SEARCH_RESULTS,
        };
        search_dir_recursive(&validated_folder, &options, &mut results, 0, &mut budget);
        search_report(results, &budget)
    })
    .await
    .map_err(|e| format!("Search worker failed: {e}"))
}

/// Appends a line to the local crash.log file for diagnostics.
/// The log file is capped at 1 MB — older entries are discarded.
#[tauri::command]
async fn append_crash_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    if line.len() > MAX_CRASH_LOG_LINE_BYTES {
        return Err(format!(
            "Crash-log entry exceeds the {} KB limit",
            MAX_CRASH_LOG_LINE_BYTES / 1024
        ));
    }
    let line = line.replace(['\r', '\n'], " ");
    let log_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Config dir error: {e}"))?;
    let _ = ensure_private_dir(&log_dir);
    let log_path = log_dir.join("crash.log");

    // Rotate if file exceeds 1 MB
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 1_048_576 {
            let old = log_dir.join("crash.log.old");
            let _ = fs::rename(&log_path, &old);
        }
    }

    let mut file =
        open_private_append(&log_path).map_err(|e| format!("Failed to open crash.log: {e}"))?;
    writeln!(file, "{}", line).map_err(|e| format!("Failed to write crash.log: {e}"))?;
    make_owner_only(&log_dir.join("crash.log.old"));
    Ok(())
}

/// Opens an app log for appending, creating it owner-only (0600 on Unix) and
/// tightening an existing file written by an older version.
fn open_private_append(path: &std::path::Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    make_owner_only(path);
    Ok(file)
}

/// Sets the native window theme (titlebar / non-client area) to match the
/// in-app theme. This matters on Windows: WebView2 can render the body dark
/// while the OS-drawn titlebar stays white because Windows controls that
/// chrome, not CSS. macOS and Linux titlebars are largely OS-managed too —
/// `Window::set_theme(None)` lets the OS pick if we ever want that.
#[tauri::command]
fn set_window_theme(window: tauri::Window, theme: String) -> Result<(), String> {
    let t = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    window
        .set_theme(t)
        .map_err(|e| format!("set_theme failed: {e}"))
}

/// Opens a zitext.com URL in the system's default browser.
/// Restricted to https://zitext.com/* to prevent arbitrary URL opening.
/// Uses tauri-plugin-opener (ShellExecuteW on Windows, LSOpenCFURLRef on macOS,
/// xdg-open on Linux) — does NOT shell out to cmd.exe, so URL metacharacters
/// like &, |, ^ in path/query cannot break out into shell interpretation.
/// Async: opening a URL starts another program, which must not block the
/// main (UI) thread. The checked, re-serialized URL is what gets opened.
#[tauri::command]
async fn open_url_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("zitext.com") {
        return Err("Only https://zitext.com URLs are permitted".to_string());
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open URL: {e}"))
}

/// Validates a link from the Markdown preview before it may be opened: only
/// web and email links, never local files or app-internal schemes.
fn validate_external_link(url: &str) -> Result<url::Url, String> {
    if url.len() > 4096 {
        return Err("Link is too long".to_string());
    }
    let parsed = url::Url::parse(url).map_err(|_| "Invalid link".to_string())?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some_and(|host| !host.is_empty()) => {
            // "https://bank.example@evil.example/" shows a trusted-looking
            // name before the real host; such links are refused outright.
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(
                    "Links that contain a user name or password can't be opened".to_string()
                );
            }
            Ok(parsed)
        }
        "mailto" => {
            // Only the ordinary message fields: some mail clients honour
            // extras such as attach=, which a document could hide in a long link.
            let allowed = ["to", "cc", "bcc", "subject", "body"];
            if parsed
                .query_pairs()
                .any(|(key, _)| !allowed.contains(&key.to_ascii_lowercase().as_str()))
            {
                return Err("This email link contains fields ZITEXT doesn't open".to_string());
            }
            Ok(parsed)
        }
        _ => Err("Only web (http/https) and email (mailto) links can be opened".to_string()),
    }
}

/// The part of a link a person checks first, shown on its own line in the
/// confirmation so it can't scroll out of view in a long link.
fn link_destination(parsed: &url::Url) -> String {
    match parsed.scheme() {
        "mailto" => format!(
            "Email to: {}",
            parsed.path().chars().take(200).collect::<String>()
        ),
        _ => format!("Website: {}", parsed.host_str().unwrap_or_default()),
    }
}

/// Opens a link clicked in the Markdown preview in the user's browser or mail
/// client, after a native confirmation that shows the full destination. The
/// confirmation is native (not renderer UI) so document content cannot fake
/// or skip it. Returns false when the user cancels.
#[tauri::command]
async fn open_external_link(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    use tauri_plugin_opener::OpenerExt;

    let parsed = validate_external_link(&url)?;
    let mut shown: String = parsed.as_str().chars().take(300).collect();
    if parsed.as_str().chars().count() > 300 {
        shown.push('…');
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Open this link outside ZITEXT?\n\n{}\n\n{shown}",
            link_destination(&parsed)
        ))
        .title("Open External Link")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |open| {
            let _ = sender.send(open);
        });
    if !receiver.await.unwrap_or(false) {
        return Ok(false);
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open link: {e}"))?;
    Ok(true)
}

/// The main webview may only ever show the app's own page. Markdown preview
/// links are intercepted in the renderer; this is the backstop for anything
/// that slips through (a relative link would otherwise reload the app and
/// discard unsaved work, and an external one would load a remote page inside
/// the trusted window).
fn is_app_navigation(url: &url::Url) -> bool {
    let app_origin = match url.scheme() {
        // macOS / Linux custom protocol.
        "tauri" => url.host_str() == Some("localhost"),
        // Windows (WebView2) serves the app from http(s)://tauri.localhost;
        // debug builds load the Vite dev server.
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
                    && url.port() == Some(1420))
        }
        // Some engines start from a blank document before loading the app.
        "about" => return url.path() == "blank",
        _ => false,
    };
    app_origin && matches!(url.path(), "/" | "/index.html")
}

// ============================================================================
// App-close confirmation
// ============================================================================

/// Set once the user has resolved unsaved changes (or there were none). The
/// window/exit handlers check this so a confirmed close is allowed through
/// instead of being intercepted again.
static CLOSE_CONFIRMED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
/// The close request the renderer has not answered yet.
struct PendingCloseRequest {
    token: String,
    issued: std::time::Instant,
    /// The renderer received it (it may be showing the unsaved-changes prompt).
    acknowledged: bool,
}
static CLOSE_REQUEST_TOKEN: OnceLock<std::sync::Mutex<Option<PendingCloseRequest>>> =
    OnceLock::new();
static FORCE_QUIT_PROMPT_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// How long a close request may go unacknowledged before a repeated request
/// offers to quit without the renderer.
const CLOSE_ACK_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
fn close_confirmed() -> &'static std::sync::atomic::AtomicBool {
    CLOSE_CONFIRMED.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

fn issue_close_request_token() -> String {
    let token = format!(
        "{:016x}{:016x}",
        rand::random::<u64>(),
        rand::random::<u64>()
    );
    if let Ok(mut pending) = CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        *pending = Some(PendingCloseRequest {
            token: token.clone(),
            issued: std::time::Instant::now(),
            acknowledged: false,
        });
    }
    token
}

/// True when the last close request is older than `grace` and the renderer
/// never acknowledged it: the page is gone, hung or crashed.
fn close_request_unanswered(grace: std::time::Duration) -> bool {
    CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .map(|pending| {
            pending
                .as_ref()
                .is_some_and(|request| !request.acknowledged && request.issued.elapsed() >= grace)
        })
        .unwrap_or(false)
}

/// The renderer confirms it received a close request.
#[tauri::command]
fn acknowledge_close_request(token: String) {
    if let Ok(mut pending) = CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    {
        if let Some(request) = pending.as_mut().filter(|request| request.token == token) {
            request.acknowledged = true;
        }
    }
}

/// Every way of closing or quitting (window close button, Cmd+Q, the Quit
/// menu item, an app exit request) goes through here: the renderer gets the
/// chance to ask about unsaved changes. If it never answered an earlier
/// request, the user is offered a native "Quit Anyway" instead of a window
/// that can't be closed.
fn request_app_close(app: &tauri::AppHandle) {
    if close_confirmed().load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if close_request_unanswered(CLOSE_ACK_GRACE) {
        offer_force_quit(app);
        return;
    }
    if let Some(window) = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
    {
        // Repeat an unacknowledged request instead of replacing it: a new one
        // would restart the grace period, so clicking close every second on
        // a hung window would never reach the Quit Anyway prompt.
        let token = pending_unacknowledged_close_token().unwrap_or_else(issue_close_request_token);
        let _ = window.emit("close-requested", token);
    }
}

fn pending_unacknowledged_close_token() -> Option<String> {
    CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()?
        .as_ref()
        .filter(|request| !request.acknowledged)
        .map(|request| request.token.clone())
}

fn offer_force_quit(app: &tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    if FORCE_QUIT_PROMPT_OPEN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(
            "ZITEXT isn't responding to the request to close.\n\n\
             Quit anyway? Changes made since the last automatic recovery snapshot \
             may be lost; the snapshot is offered again at the next launch.",
        )
        .title("Quit ZITEXT?")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit Anyway".to_string(),
            "Keep Waiting".to_string(),
        ))
        .show(move |quit| {
            FORCE_QUIT_PROMPT_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
            if quit {
                close_confirmed().store(true, std::sync::atomic::Ordering::SeqCst);
                cleanup_wait_locks();
                handle.exit(0);
            }
        });
}

fn consume_close_request_token(token: &str) -> bool {
    let Ok(mut pending) = CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    else {
        return false;
    };
    if pending
        .as_ref()
        .is_some_and(|request| request.token == token)
    {
        pending.take();
        true
    } else {
        false
    }
}

/// Called by the renderer once the user has dealt with unsaved changes. A
/// one-use token proves that an OS/native close request initiated this flow;
/// renderer code cannot close the app at an arbitrary time.
#[tauri::command]
async fn confirm_app_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    token: String,
    keep_session: Option<bool>,
) -> Result<(), String> {
    if !consume_close_request_token(&token) {
        return Err("No matching native close request is pending".to_string());
    }
    close_confirmed().store(true, std::sync::atomic::Ordering::SeqCst);
    // Clear the saved session synchronously so the next launch starts fresh.
    // This replaces the renderer's fire-and-forget beforeunload clear, which
    // could race teardown and leave a stale session (spurious restore prompt).
    // Crash/kill paths skip this and still restore from the periodic snapshot.
    // If the restore prompt for the previous session was never resolved, keep
    // that session: quitting is not a decision to discard its recovery data,
    // and the next launch asks again. The renderer's crash screen also asks to
    // keep it (`keep_session`), because the last periodic snapshot is the only
    // copy of the unsaved work that was open when the UI failed.
    let clear_session = !session_snapshot_blocked() && !keep_session.unwrap_or(false);
    {
        let _guard = settings_lock().lock().await;
        if let Ok(mut settings) = load_settings(app.clone()).await {
            if clear_session {
                settings.last_session = Vec::new();
                settings.active_tab_path = None;
            }
            // Remember where the window was, for the next launch. While
            // maximized, keep the size it had before (if known).
            if let Some(mut state) = capture_window_state(&window) {
                if state.maximized {
                    if let Some(previous) = settings.window_state {
                        (state.x, state.y, state.width, state.height) =
                            (previous.x, previous.y, previous.width, previous.height);
                    }
                }
                settings.window_state = Some(state);
            }
            let _ = write_settings_to_disk(app, settings).await;
        }
    }
    cleanup_wait_locks();
    window
        .close()
        .map_err(|e| format!("Failed to close window: {e}"))
}

#[tauri::command]
fn cancel_app_close(token: String) -> Result<(), String> {
    if consume_close_request_token(&token) {
        Ok(())
    } else {
        Err("No matching native close request is pending".to_string())
    }
}

/// Grants access to a path the renderer wants to reopen from the in-app Recent
/// Files list or Welcome screen. Only succeeds if the path is present in the
/// persisted recent-files / last-session lists — so the renderer can reopen
/// things the user previously opened, but cannot self-authorize an arbitrary
/// path. (The macOS native recent menu grants via `on_menu_event` instead.)
#[tauri::command]
async fn grant_recent_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let settings = load_settings(app).await?;
    // Only the user-curated recent-files list — NOT the auto-saved last_session.
    // last_session paths are granted exclusively through the consent-gated
    // native session-restore prompt, so a compromised renderer
    // can't widen its reach to the whole previous session by calling this.
    let known = is_known_recent_path(&path, &settings.recent_files);
    if known {
        grant_file(std::path::Path::new(&path));
        Ok(())
    } else {
        Err("Path is not in the recent-files list".to_string())
    }
}

fn is_known_recent_path(path: &str, recent_files: &[String]) -> bool {
    recent_files.iter().any(|known| known == path)
}

/// Criterion entry points for `benches/file_operations.rs`. Each runs the
/// command the app itself calls — authorization, identity checks, hashing,
/// the NUL scan and the save's conflict re-read included — so the numbers
/// measure production code rather than a copy of part of it. They are not
/// Tauri commands and do not expand the renderer IPC surface.
#[doc(hidden)]
pub mod benchmark_support {
    use super::*;

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn path_string(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    pub fn authorize_for_benchmark(path: &std::path::Path) -> Result<PathBuf, String> {
        grant_file(path);
        authorize_path(&path_string(path))
    }

    /// Opens a project folder, as choosing it in the folder dialog does.
    pub fn open_folder(path: &std::path::Path) {
        grant_folder(path);
    }

    /// `read_file_content`; returns the decoded length.
    pub fn read_file(path: &std::path::Path) -> Result<usize, String> {
        grant_file(path);
        run(read_file_content(path_string(path))).map(|read| read.content.len())
    }

    /// A file open in a tab, saved the way the editor saves it: each write
    /// passes the version the previous one produced, so the backend re-reads
    /// and compares before replacing the file.
    pub struct OpenFile {
        path: String,
        modified: u64,
        size: u64,
        hash: String,
    }

    pub fn open_file(path: &std::path::Path) -> Result<OpenFile, String> {
        grant_file(path);
        let read = run(read_file_content(path_string(path)))?;
        Ok(OpenFile {
            path: read.path,
            modified: read.modified,
            size: read.size,
            hash: read.hash,
        })
    }

    impl OpenFile {
        pub fn save(&mut self, content: &str) -> Result<(), String> {
            let written = run(write_file_content(
                self.path.clone(),
                content.to_string(),
                None,
                Some(self.modified),
                Some(self.size),
                Some(self.hash.clone()),
                None,
            ))?;
            self.modified = written.modified;
            self.size = written.size;
            self.hash = written.hash;
            Ok(())
        }
    }

    /// `search_in_files` over an opened folder; returns the match count.
    pub fn search_folder(folder: &std::path::Path, query: &str) -> Result<usize, String> {
        run(search_in_files(
            path_string(folder),
            query.to_string(),
            false,
            false,
        ))
        .map(|report| report.matches.len())
    }

    /// `read_directory` (one level, as the explorer lists); returns the count.
    pub fn list_folder(folder: &std::path::Path) -> Result<usize, String> {
        run(read_directory(path_string(folder), false)).map(|listing| listing.entries.len())
    }

    /// `count_project_files`, which fills the explorer footer.
    pub fn count_files(folder: &std::path::Path) -> Result<usize, String> {
        run(count_project_files(path_string(folder))).map(|total| total.count)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_session_bus_available() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|address| !address.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR")
            .is_some_and(|dir| std::path::Path::new(&dir).join("bus").exists())
}

/// A second launch (CLI wrapper `open -n`, or running the binary directly)
/// handed us its arguments and working directory, then exited.
fn handle_secondary_launch(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    dlog!("Secondary instance launched with args: {:?}", args);
    let parsed = parse_cli_args(&args, std::path::Path::new(&cwd));
    for (file_path, lock_path) in &parsed.wait_locks {
        let _ = register_wait_lock(file_path, lock_path);
    }
    deliver_open_requests(app, parsed.files, parsed.folder);

    let _ = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().values().next().cloned())
        .map(|w| w.set_focus());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Linux, disable webkit2gtk DMABUF rendering, which otherwise prevents
    // the window from displaying on some GPU/driver/compositor combinations
    // (notably NVIDIA proprietary drivers). Must be set before webkit2gtk
    // initializes (before tauri::Builder runs); an explicit user-set value is
    // preserved.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Rust panic hook — writes to crash.log even if the UI is dead.
    std::panic::set_hook(Box::new(|info| {
        let message = format!("{}", info);
        eprintln!("PANIC: {}", message);
        if let Some(dirs) = dirs::config_dir() {
            let log_dir = dirs.join("com.zitrino.zitext");
            // Create the directory too: a panic before the first settings
            // write used to be lost because crash.log had nowhere to go.
            let _ = ensure_private_dir(&log_dir);
            let log_path = log_dir.join("crash.log");
            if let Ok(mut f) = open_private_append(&log_path) {
                use std::io::Write;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(
                    f,
                    r#"{{"ts":"{}","level":"panic","source":"rust","message":{}}}"#,
                    ts,
                    serde_json::to_string(&message).unwrap_or_default()
                );
            }
        }
    }));

    // macOS: hand our arguments to a running instance (and exit) before
    // anything else starts. Windows/Linux keep the plugin (named mutex and
    // window message / per-user D-Bus session bus), which is not affected.
    #[cfg(target_os = "macos")]
    macos_single_instance::acquire_or_exit();

    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(handle_secondary_launch));
    // On Linux the plugin needs the D-Bus session bus and panics without one
    // (a bare X session, some containers); launch without single-instance.
    #[cfg(all(unix, not(target_os = "macos")))]
    let builder = if linux_session_bus_available() {
        builder.plugin(tauri_plugin_single_instance::init(handle_secondary_launch))
    } else {
        builder
    };

    builder
        .plugin(tauri_plugin_dialog::init())
        // ZITEXT opens links itself (open_external_link, with confirmation);
        // the plugin's injected link-click script is not wanted.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
                .on_navigation(|_webview, url| {
                    let allowed = is_app_navigation(url);
                    if !allowed {
                        dlog!("Blocked webview navigation to {}", url);
                    }
                    allowed
                })
                .build(),
        )
        .setup(|app| {
            start_wait_lock_heartbeat();
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                macos_single_instance::serve(move |args, cwd| {
                    handle_secondary_launch(&handle, args, cwd)
                });
            }
            // Native menubar stays macOS-only. Windows/Linux render an in-app
            // <MenuBar> React component instead — adding a native menubar
            // there would duplicate the UI. The Layer-1 protection (renderer
            // cannot invoke dialog primitives directly) holds regardless,
            // because `request_menu_action` is the only renderer-callable
            // dialog entry on every platform.
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle();
                let menu = build_app_menu(handle, Vec::new(), &HashMap::new())?;
                app.set_menu(menu)?;
            }

            // Restore access to a previously-opened folder so the file explorer
            // works after a restart. Read straight from the settings file
            // (trusted), not from the renderer, keeping the grant model
            // fail-closed.
            if let Ok(cfg) = get_config_path(app.handle().clone()) {
                if let Ok(content) = fs::read_to_string(&cfg) {
                    if let Ok(prev) = serde_json::from_str::<AppSettings>(&content) {
                        if let Some(folder) = prev.opened_folder.as_deref() {
                            grant_folder(std::path::Path::new(folder));
                        }
                        if let (Some(state), Some(window)) =
                            (prev.window_state, app.get_webview_window("main"))
                        {
                            restore_window_state(&window, state);
                        }
                    }
                }
            }

            app.on_menu_event(move |app, event| {
                let id_owned = event.id().as_ref().to_string();
                let id = id_owned.as_str();

                // Recent files: grant the path here (so the renderer doesn't
                // need a separate grant step), then emit `menu-recent-file`
                // which the renderer handles with cursor/scroll restoration
                // from the last saved session.
                if let Some(path) = id.strip_prefix("recent:") {
                    grant_file(std::path::Path::new(path));
                    let _ = app.emit("menu-recent-file", path);
                    return;
                }
                // Quit asks about unsaved changes like closing the window.
                // (The predefined Quit item terminates without asking.)
                if id == "quit" {
                    request_app_close(app);
                    return;
                }

                // For file-dialog menu items (open / open_folder / save_as),
                // we emit `menu-{id}` like every other menu event. The
                // renderer's existing handler invokes `request_menu_action`,
                // which goes through the SAME Rust internal dialog functions.
                //
                // This preserves all renderer side effects (sidebar expansion,
                // settings persistence, active-tab context for save_as, etc.)
                // that the renderer-side handlers already do. The security
                // protection comes from `request_menu_action` being the only
                // renderer-callable dialog entry — not from Rust skipping the
                // renderer round-trip.
                let _ = app.emit(format!("menu-{}", id).as_str(), ());
            });

            // Window events: confirm-on-close when there are unsaved changes,
            // and OS drag-and-drop (granted here because the renderer cannot
            // self-authorize a dropped path).
            if let Some(win) = app.get_webview_window("main") {
                let event_win = win.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        if !close_confirmed().load(std::sync::atomic::Ordering::SeqCst) {
                            api.prevent_close();
                            request_app_close(event_win.app_handle());
                        }
                    }
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                        let mut files = Vec::new();
                        let mut folder = None;
                        for p in paths {
                            if p.is_dir() {
                                grant_folder(p);
                                folder = Some(p.to_string_lossy().to_string());
                            } else if p.is_file() {
                                grant_file(p);
                                files.push(p.to_string_lossy().to_string());
                            }
                        }
                        deliver_open_requests(event_win.app_handle(), files, folder);
                    }
                    _ => {}
                });
            }

            // Session-restore consent is security-sensitive because accepting
            // it releases previous file paths and unsaved content to the
            // renderer. Collect the decision in a native dialog so compromised
            // renderer JavaScript cannot approve its own access.
            let handle_for_restore = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

                let settings = match load_settings(handle_for_restore.clone()).await {
                    Ok(s) => s,
                    Err(_) => {
                        set_session_decision(false);
                        return;
                    }
                };

                let file_paths: Vec<String> = settings
                    .last_session
                    .iter()
                    .filter(|s| !s.is_untitled)
                    .map(|s| s.path.clone())
                    .collect();

                if file_paths.is_empty() {
                    set_session_decision(true);
                    return;
                }

                // Give the application window a moment to become visible so the
                // native prompt has an obvious owner in every desktop backend.
                tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;

                let file_count = file_paths.len();
                let late_restore_handle = handle_for_restore.clone();
                handle_for_restore
                    .dialog()
                    .message(format!(
                        "ZITEXT found a previous editing session with {file_count} file(s). \
                         Restore those files and any recovered unsaved edits?"
                    ))
                    .title("Restore Previous Session")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Restore".to_string(),
                        "Skip".to_string(),
                    ))
                    .show(move |restore| {
                        if restore {
                            for path in &file_paths {
                                grant_file(std::path::Path::new(path));
                            }
                        }
                        set_session_decision(restore);
                        if SESSION_LATE_RESTORE_PENDING.load(std::sync::atomic::Ordering::SeqCst) {
                            if restore {
                                // The renderer stopped waiting; tell it to
                                // fetch the now-released file entries.
                                let _ = late_restore_handle.emit("session-restore-late", ());
                            } else {
                                SESSION_LATE_RESTORE_PENDING
                                    .store(false, std::sync::atomic::Ordering::SeqCst);
                            }
                        }
                    });
            });

            // Handle initial command-line arguments. The shell wrapper creates
            // unpredictable lock files and explicitly hands their paths to us;
            // this keeps filenames with spaces intact and avoids predictable
            // temp paths or full document paths in lock filenames.
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            let parsed = parse_cli_args(&args, &cwd);
            let startup_files = parsed.files;
            let startup_folder = parsed.folder;
            for (file_path, lock_path) in parsed.wait_locks {
                let _ = register_wait_lock(&file_path, &lock_path);
            }
            {
                let args_store = STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
                if let Ok(mut v) = args_store.lock() {
                    v.extend(startup_files);
                }
            }
            // The renderer collects these with get_startup_args and
            // get_startup_folder once its listeners are ready.
            if let Ok(mut pending) = STARTUP_FOLDER
                .get_or_init(|| std::sync::Mutex::new(None))
                .lock()
            {
                *pending = startup_folder;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            request_menu_action,
            read_file_content,
            write_file_content,
            read_settings,
            settings_file_exists,
            write_settings,
            get_recent_files,
            add_recent_file,
            set_opened_folder,
            save_session,
            get_last_session,
            get_startup_args,
            get_startup_folder,
            signal_tab_closed,
            retarget_document,
            release_folder_access,
            acknowledge_close_request,
            // Directory and file-metadata commands
            read_directory,
            get_file_metadata,
            get_files_metadata,
            rename_file,
            rebuild_native_menu,
            // Find in Files commands
            search_in_files,
            find_files_by_name,
            append_crash_log,
            open_url_in_browser,
            open_external_link,
            set_window_theme,
            count_project_files,
            grant_recent_path,
            confirm_app_close,
            cancel_app_close,
            read_scratchpad,
            write_scratchpad,
            // Large file and log viewer
            large_file::large_file_open,
            large_file::large_file_status,
            large_file::large_file_refresh,
            large_file::large_file_lines,
            large_file::large_file_set_filter,
            large_file::large_file_filter_status,
            large_file::large_file_filtered_lines,
            large_file::large_file_search,
            large_file::large_file_find_time,
            large_file::large_file_export,
            large_file::large_file_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                // Intercept app exit (e.g. macOS Cmd+Q) so the renderer can
                // prompt to save unsaved work first. confirm_app_close sets the
                // flag and closes the window, allowing the exit through.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if !close_confirmed().load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_exit();
                        request_app_close(app_handle);
                    }
                }
                tauri::RunEvent::Exit => {
                    cleanup_wait_locks();
                    #[cfg(target_os = "macos")]
                    macos_single_instance::cleanup();
                }
                // Handle files opened via macOS Finder ("Open With" / file
                // associations). RunEvent::Opened only exists on macOS.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let handle = app_handle.clone();
                    // macOS "Open With ZITEXT", or a folder dropped on the Dock
                    // icon: grant before forwarding, whether the renderer is
                    // ready now or these queue.
                    let mut files = Vec::new();
                    let mut folder = None;
                    for path in urls
                        .iter()
                        .filter(|u: &&url::Url| u.scheme() == "file")
                        .filter_map(|u: &url::Url| u.to_file_path().ok())
                    {
                        if path.is_dir() {
                            grant_folder(&path);
                            folder = Some(clean_path(path));
                        } else if path.is_file() {
                            grant_file(&path);
                            files.push(clean_path(path));
                        }
                    }
                    if !files.is_empty() || folder.is_some() {
                        deliver_open_requests(&handle, files, folder);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_file(path: String, is_untitled: bool) -> SessionFile {
        SessionFile {
            path,
            cursor_line: 1,
            cursor_column: 1,
            scroll_top: 0.0,
            scroll_left: 0.0,
            is_untitled,
            is_dirty: false,
            is_active: false,
            content: is_untitled.then(String::new),
            base_version: None,
        }
    }

    #[test]
    fn snapshots_during_a_pending_late_restore_keep_the_unrestored_files() {
        let stored = vec![
            session_file("/work/open.txt".into(), false),
            {
                let mut recovered = session_file("/work/unsaved.txt".into(), false);
                recovered.is_dirty = true;
                recovered.is_active = true;
                recovered.content = Some("edits typed before the crash".into());
                recovered
            },
            session_file("untitled-1".into(), true),
        ];
        let snapshot = vec![
            session_file("/work/open.txt".into(), false),
            session_file("untitled-1".into(), true),
            session_file("/work/new.txt".into(), false),
        ];

        let merged = keep_unrestored_entries(snapshot, stored);
        let paths: Vec<&str> = merged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "/work/open.txt",
                "untitled-1",
                "/work/new.txt",
                "/work/unsaved.txt"
            ],
            "the renderer's tabs come first; unrestored files follow, nothing twice"
        );
        let kept = &merged[3];
        assert_eq!(
            kept.content.as_deref(),
            Some("edits typed before the crash")
        );
        assert!(
            !kept.is_active,
            "the renderer's active tab stays the active one"
        );

        let full: Vec<SessionFile> = (0..MAX_SESSION_FILES)
            .map(|i| session_file(format!("/work/{i}.txt"), false))
            .collect();
        let capped = keep_unrestored_entries(full, vec![session_file("/x.txt".into(), false)]);
        assert_eq!(capped.len(), MAX_SESSION_FILES);
    }

    #[test]
    fn session_base_version_round_trips_and_drops_malformed_hashes() {
        // Older snapshots have no base_version and must still load.
        let legacy: SessionFile = serde_json::from_str(
            r#"{"path":"/tmp/a.txt","cursor_line":1,"cursor_column":1,"is_dirty":true,"content":"x"}"#,
        )
        .expect("legacy session entry");
        assert!(legacy.base_version.is_none());

        let mut entry = session_file("Untitled-1".to_string(), true);
        entry.base_version = Some(SessionDiskVersion {
            modified: 1,
            size: 2,
            hash: "h".repeat(MAX_SESSION_HASH_LEN + 1),
        });
        let mut session = vec![entry];
        validate_session_entries(&mut session, None);
        assert_eq!(
            session.len(),
            1,
            "a malformed base version must not drop the entry"
        );
        assert!(session[0].base_version.is_none());

        session[0].base_version = Some(SessionDiskVersion {
            modified: 1,
            size: 2,
            hash: "a".repeat(64),
        });
        validate_session_entries(&mut session, None);
        let json = serde_json::to_string(&session[0]).expect("serialize");
        assert!(json.contains("\"base_version\""));
    }

    #[test]
    fn ungranted_paths_are_denied_and_exact_grants_do_not_cover_siblings() {
        let directory = tempfile::tempdir().expect("temp directory");
        let granted = directory.path().join("granted.txt");
        let sibling = directory.path().join("sibling.txt");
        fs::write(&granted, b"granted").expect("write granted fixture");
        fs::write(&sibling, b"private").expect("write sibling fixture");

        assert!(authorize_path(sibling.to_str().unwrap()).is_err());
        grant_file(&granted);
        assert!(authorize_path(granted.to_str().unwrap()).is_ok());
        assert!(authorize_path(sibling.to_str().unwrap()).is_err());
    }

    #[test]
    fn hostile_renderer_cannot_add_or_restore_ungranted_paths() {
        let directory = tempfile::tempdir().expect("temp directory");
        let private = directory.path().join("not-opened.txt");
        fs::write(&private, b"private").expect("write fixture");
        let path = private.to_string_lossy().to_string();

        assert!(validate_recent_candidate(&path).is_err());
        let mut session = vec![session_file(path.clone(), false)];
        // The ungranted entry is dropped (never stored) and cannot be active.
        assert_eq!(validate_session_entries(&mut session, Some(path)), None);
        assert!(session.is_empty());
    }

    #[cfg(unix)]
    fn mode_of(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn app_state_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("temp directory");
        let config_dir = directory.path().join("com.zitrino.zitext");
        let settings = config_dir.join("settings.json");

        let valid = serde_json::to_vec(&AppSettings::default()).unwrap();
        atomic_write_private(&settings, &valid).expect("private write");
        assert_eq!(mode_of(&settings), 0o600);
        assert_eq!(mode_of(&config_dir), 0o700);

        // A file written by an older version with the default umask is
        // tightened on the next read.
        fs::set_permissions(&settings, fs::Permissions::from_mode(0o644)).unwrap();
        load_settings_from_path(&settings).expect("load");
        assert_eq!(mode_of(&settings), 0o600);

        let log = config_dir.join("crash.log");
        open_private_append(&log).expect("open log");
        assert_eq!(mode_of(&log), 0o600);
    }

    #[test]
    fn invalid_utf8_settings_are_quarantined_and_backups_pruned() {
        let directory = tempfile::tempdir().expect("temp directory");
        let settings = directory.path().join("settings.json");
        for _ in 0..(MAX_SETTINGS_BACKUPS + 2) {
            fs::write(&settings, b"{\"theme\": \"dark\xff\"}").expect("write corrupt");
            let loaded =
                load_settings_from_path(&settings).expect("corrupt settings must not error");
            assert_eq!(loaded.theme, AppSettings::default().theme);
            assert!(!settings.exists(), "corrupt file is moved aside");
        }
        let backups: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| is_settings_backup_name(name, "settings"))
            })
            .collect();
        assert_eq!(backups.len(), MAX_SETTINGS_BACKUPS);
        #[cfg(unix)]
        for backup in backups {
            assert_eq!(mode_of(&backup.path()), 0o600);
        }
    }

    #[test]
    fn the_scratchpad_is_kept_privately_and_within_its_size() {
        let directory = tempfile::tempdir().expect("temp directory");
        let config = directory.path().join("app").join("settings.json");
        let path = scratchpad_path_for(&config);
        assert_eq!(
            read_scratchpad_file(&path),
            Ok(String::new()),
            "nothing saved yet"
        );

        write_scratchpad_file(&path, "SELECT 1;\nnotes ✓").expect("write");
        assert_eq!(read_scratchpad_file(&path).unwrap(), "SELECT 1;\nnotes ✓");
        write_scratchpad_file(&path, "").expect("emptied");
        assert_eq!(read_scratchpad_file(&path).unwrap(), "");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        let too_big = "x".repeat(MAX_SCRATCHPAD_BYTES + 1);
        assert!(write_scratchpad_file(&path, &too_big).is_err());
        assert_eq!(
            read_scratchpad_file(&path).unwrap(),
            "",
            "a refused write changes nothing"
        );
        fs::write(&path, &too_big).unwrap();
        assert!(read_scratchpad_file(&path).is_err());
    }

    #[test]
    fn a_damaged_session_file_is_set_aside_under_its_own_name() {
        let directory = tempfile::tempdir().expect("temp directory");
        let settings = directory.path().join("settings.json");
        fs::write(&settings, b"{}").unwrap();
        // Three settings backups already exist; a damaged session file must
        // not push them out.
        for i in 0..MAX_SETTINGS_BACKUPS {
            fs::write(
                directory.path().join(format!("settings.corrupt.{i}.json")),
                b"x",
            )
            .unwrap();
        }
        let session = directory.path().join("session.json");
        fs::write(&session, b"not json").unwrap();

        load_settings_from_path(&settings).expect("load");
        let names: Vec<String> = fs::read_dir(directory.path())
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .collect();
        assert!(
            names.iter().any(|n| n.starts_with("session.corrupt.")),
            "{names:?}"
        );
        assert_eq!(
            names
                .iter()
                .filter(|n| n.starts_with("settings.corrupt."))
                .count(),
            MAX_SETTINGS_BACKUPS
        );
        assert!(!session.exists());
    }

    #[test]
    fn a_file_count_cut_short_is_marked_partial() {
        static COUNTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let directory = tempfile::tempdir().expect("temp directory");
        fs::write(directory.path().join("a.txt"), b"").unwrap();
        let budget = |seconds| CountBudget {
            supersede: Supersede::claim(&COUNTS),
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(seconds),
        };

        let mut complete = FileCount::default();
        count_files_recursive(directory.path(), 0, &mut complete, &budget(60));
        assert_eq!((complete.count, complete.partial), (1, false));

        let mut cut_short = FileCount::default();
        count_files_recursive(directory.path(), 0, &mut cut_short, &budget(0));
        assert!(
            cut_short.partial,
            "a count stopped by the time limit is not exact"
        );
    }

    #[test]
    fn interrupted_save_temp_files_are_swept() {
        let directory = tempfile::tempdir().expect("temp directory");
        let old_temp = directory.path().join(".zitext-write-AbC123");
        let fresh_temp = directory.path().join(".zitext-write-XyZ789");
        let lookalike = directory.path().join(".zitext-write-notes.txt");
        for path in [&old_temp, &fresh_temp, &lookalike] {
            fs::write(path, b"partial").unwrap();
        }
        let two_hours_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        for path in [&old_temp, &lookalike] {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(two_hours_ago)
                .unwrap();
        }

        atomic_write_file(&directory.path().join("doc.txt"), b"saved").expect("save");

        assert!(!old_temp.exists(), "stale temp file removed");
        assert!(
            fresh_temp.exists(),
            "a temp file that may belong to a save in progress is kept"
        );
        assert!(lookalike.exists(), "only exact temp names are touched");
    }

    #[test]
    fn webview_may_only_navigate_to_the_app_page() {
        let allowed = |u: &str| is_app_navigation(&url::Url::parse(u).unwrap());
        assert!(allowed("tauri://localhost/"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("https://tauri.localhost/index.html"));
        assert!(allowed("about:blank"));
        // A relative preview link resolves inside the app origin but must not
        // reload the app.
        assert!(!allowed("tauri://localhost/docs/guide.md"));
        assert!(!allowed("http://tauri.localhost/README.md"));
        assert!(!allowed("https://example.com/"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("tauri://evil/"));
        assert!(!allowed("about:srcdoc"));
    }

    #[test]
    fn only_web_and_email_links_can_be_opened_externally() {
        assert!(validate_external_link("https://example.com/a?b=1").is_ok());
        assert!(validate_external_link("http://example.com").is_ok());
        assert!(validate_external_link("mailto:dev@example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost/",
            "ftp://example.com/x",
            "http://",
            "not a url",
        ] {
            assert!(
                validate_external_link(bad).is_err(),
                "{bad} must be rejected"
            );
        }
        assert!(
            validate_external_link(&format!("https://example.com/{}", "a".repeat(5000))).is_err()
        );
    }

    #[test]
    fn one_bad_session_entry_does_not_disable_recovery_for_the_others() {
        let directory = tempfile::tempdir().expect("temp directory");
        let granted = directory.path().join("granted.txt");
        fs::write(&granted, b"granted").expect("write fixture");
        grant_file(&granted);
        let granted_path = clean_path(authorize_path(granted.to_str().unwrap()).unwrap());
        let gone = directory.path().join("deleted-dir").join("gone.txt");

        let mut dirty = session_file(granted_path.clone(), false);
        dirty.is_dirty = true;
        dirty.content = Some("unsaved edits".to_string());
        let mut untitled = session_file("Untitled-1".to_string(), true);
        untitled.content = Some("scratch".to_string());
        let mut session = vec![
            session_file(gone.to_string_lossy().to_string(), false),
            dirty,
            untitled,
        ];

        let active = validate_session_entries(&mut session, Some(granted_path.clone()));
        assert_eq!(active.as_deref(), Some(granted_path.as_str()));
        assert_eq!(session.len(), 2);
        assert_eq!(session[0].content.as_deref(), Some("unsaved edits"));
        assert_eq!(session[1].content.as_deref(), Some("scratch"));
    }

    #[test]
    fn session_content_over_budget_is_trimmed_not_rejected() {
        let big = "x".repeat(MAX_SESSION_CONTENT_BYTES);
        let mut session: Vec<SessionFile> = (0..5)
            .map(|i| {
                let mut entry = session_file(format!("Untitled-{i}"), true);
                entry.content = Some(big.clone());
                entry
            })
            .collect();
        validate_session_entries(&mut session, None);
        // 32 MiB total fits three full 10 MiB buffers; the rest are dropped.
        assert_eq!(
            session.len(),
            MAX_SESSION_TOTAL_BYTES / MAX_SESSION_CONTENT_BYTES
        );

        let mut many: Vec<SessionFile> = (0..MAX_SESSION_FILES + 5)
            .map(|i| {
                let mut entry = session_file(format!("Untitled-{i}"), true);
                entry.content = Some("a".to_string());
                entry
            })
            .collect();
        validate_session_entries(&mut many, None);
        assert_eq!(many.len(), MAX_SESSION_FILES);
    }

    #[test]
    fn renderer_settings_cannot_replace_authority_bearing_fields() {
        let current = AppSettings {
            recent_files: vec!["trusted.txt".to_string()],
            opened_folder: Some("trusted-folder".to_string()),
            last_session: vec![session_file("trusted.txt".to_string(), false)],
            active_tab_path: Some("trusted.txt".to_string()),
            ..AppSettings::default()
        };

        let incoming = AppSettings {
            recent_files: vec!["attacker.txt".to_string()],
            opened_folder: Some("attacker-folder".to_string()),
            last_session: vec![session_file("attacker.txt".to_string(), false)],
            active_tab_path: Some("attacker.txt".to_string()),
            ..AppSettings::default()
        };
        let preserved = preserve_authority_settings(incoming, &current);

        assert_eq!(preserved.recent_files, current.recent_files);
        assert_eq!(preserved.opened_folder, current.opened_folder);
        assert_eq!(preserved.last_session[0].path, "trusted.txt");
        assert_eq!(preserved.active_tab_path, current.active_tab_path);
    }

    #[test]
    fn recent_grants_require_an_exact_backend_owned_entry() {
        let recents = vec!["/home/user/project.txt".to_string()];
        assert!(is_known_recent_path("/home/user/project.txt", &recents));
        assert!(!is_known_recent_path(
            "/home/user/project.txt/../secret",
            &recents
        ));
        assert!(!is_known_recent_path(
            "/home/user/project.txt.bak",
            &recents
        ));
    }

    #[test]
    fn skipping_restore_only_releases_untitled_buffers() {
        let session = vec![
            session_file("/private/document.txt".to_string(), false),
            session_file("Untitled-1".to_string(), true),
        ];
        let filtered = filter_session_for_restore(session, false);
        assert_eq!(filtered.len(), 1);
        assert!(filtered[0].is_untitled);
    }

    #[test]
    fn atomic_write_replaces_complete_content_and_preserves_permissions() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("document.txt");
        fs::write(&path, b"old").expect("write fixture");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640))
                .expect("set fixture permissions");
        }

        atomic_write_file(&path, b"new complete content").expect("atomic write");
        assert_eq!(fs::read(&path).unwrap(), b"new complete content");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
    }

    #[test]
    fn deleted_file_save_reports_a_structured_conflict() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("deleted.txt");
        fs::write(&path, b"original").expect("write fixture");
        let metadata = fs::metadata(&path).expect("fixture metadata");
        let modified = modified_millis(&metadata);
        let size = metadata.len();
        let hash = content_hash(b"original");
        fs::remove_file(&path).expect("delete fixture");

        let error = write_file_content_sync(
            path,
            "replacement".to_string(),
            Some("UTF-8".to_string()),
            modified,
            Some(size),
            Some(hash),
            false,
        )
        .expect_err("deleted file must conflict before overwrite confirmation");
        assert!(error.starts_with("ZITEXT_FILE_CONFLICT:"));
    }

    fn reopen_and_save(
        path: &std::path::Path,
        allow_read_only: bool,
    ) -> Result<FileWriteResult, String> {
        let read = read_file_content_sync(path.to_path_buf())?;
        write_file_content_sync(
            path.to_path_buf(),
            read.content,
            Some(read.encoding),
            Some(read.modified),
            Some(read.size),
            Some(read.hash),
            allow_read_only,
        )
    }

    #[test]
    fn utf8_bom_is_kept_on_save() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = fs::canonicalize(directory.path()).unwrap().join("bom.txt");
        fs::write(&path, b"\xEF\xBB\xBFname,value\n").expect("write fixture");
        grant_file(&path);

        let read = read_file_content_sync(path.clone()).expect("read");
        assert_eq!(read.encoding, "UTF-8 with BOM");
        assert_eq!(read.content, "name,value\n");
        reopen_and_save(&path, false).expect("save");
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFname,value\n");
    }

    #[test]
    fn bom_plus_invalid_byte_round_trips_as_windows_1252() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = fs::canonicalize(directory.path())
            .unwrap()
            .join("mixed.txt");
        let original = b"\xEF\xBB\xBFcaf\xE9\n".to_vec();
        fs::write(&path, &original).expect("write fixture");
        grant_file(&path);

        let read = read_file_content_sync(path.clone()).expect("read");
        assert_eq!(read.encoding, "Windows-1252");
        reopen_and_save(&path, false).expect("save must succeed");
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn utf16_files_are_refused_with_a_clear_message() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = fs::canonicalize(directory.path())
            .unwrap()
            .join("utf16.txt");
        fs::write(&path, b"\xFF\xFEh\0i\0").expect("write fixture");
        grant_file(&path);
        let error = read_file_content_sync(path).expect_err("UTF-16 is not editable");
        assert!(error.contains("UTF-16"), "{error}");
    }

    #[test]
    fn size_limit_applies_to_the_encoded_bytes() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = fs::canonicalize(directory.path())
            .unwrap()
            .join("large-1252.txt");
        // 6 MiB on disk, 12 MiB once decoded to UTF-8 text.
        let original = vec![0xE9u8; 6 * 1024 * 1024];
        fs::write(&path, &original).expect("write fixture");
        grant_file(&path);

        let read = read_file_content_sync(path.clone()).expect("read");
        assert!(read.content.len() > MAX_FILE_SIZE as usize);
        let result = tauri::async_runtime::block_on(write_file_content(
            path.to_string_lossy().to_string(),
            read.content,
            Some(read.encoding),
            Some(read.modified),
            Some(read.size),
            Some(read.hash),
            None,
        ));
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn read_only_file_needs_confirmation_and_stays_read_only() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("locked.txt");
        fs::write(&path, b"original").expect("write fixture");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let error = write_file_content_sync(
            path.clone(),
            "changed".into(),
            None,
            None,
            None,
            None,
            false,
        )
        .expect_err("read-only file must not be replaced silently");
        assert!(error.starts_with("ZITEXT_READ_ONLY_FILE:"), "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"original");

        write_file_content_sync(path.clone(), "changed".into(), None, None, None, None, true)
            .expect("confirmed save");
        assert_eq!(fs::read(&path).unwrap(), b"changed");
        assert!(fs::metadata(&path).unwrap().permissions().readonly());

        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        let _ = fs::set_permissions(&path, permissions);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_locked_files_count_as_read_only() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("locked.txt");
        fs::write(&path, b"original").unwrap();
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: valid NUL-terminated path.
        assert_eq!(
            unsafe { libc::chflags(c_path.as_ptr(), libc::UF_IMMUTABLE as _) },
            0
        );
        let locked = is_write_protected(&path, &fs::metadata(&path).unwrap());
        // SAFETY: as above; unlock so the temp directory can be removed.
        unsafe { libc::chflags(c_path.as_ptr(), 0) };
        assert!(locked);
        assert!(!is_write_protected(&path, &fs::metadata(&path).unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn writable_file_in_read_only_folder_is_saved_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = directory.path().join("locked-folder");
        fs::create_dir(&folder).unwrap();
        let path = folder.join("notes.txt");
        fs::write(&path, b"original").expect("write fixture");
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();

        let result = write_file_content_sync(
            path.clone(),
            "changed".into(),
            None,
            None,
            None,
            None,
            false,
        );
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        result.expect("in-place save");
        assert_eq!(fs::read(&path).unwrap(), b"changed");
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_file_keeps_its_links_in_sync() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("a.txt");
        let sibling = directory.path().join("b.txt");
        fs::write(&path, b"original").expect("write fixture");
        fs::hard_link(&path, &sibling).unwrap();

        write_file_content_sync(
            path.clone(),
            "changed".into(),
            None,
            None,
            None,
            None,
            false,
        )
        .expect("save");
        assert_eq!(fs::read(&sibling).unwrap(), b"changed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn extended_attributes_survive_a_save() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("tagged.txt");
        fs::write(&path, b"original").expect("write fixture");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = std::ffi::CString::new("com.zitext.test").unwrap();
        let value = b"kept";
        // SAFETY: valid NUL-terminated strings and a buffer of the given size.
        let set = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0);

        write_file_content_sync(
            path.clone(),
            "changed".into(),
            None,
            None,
            None,
            None,
            false,
        )
        .expect("save");
        let mut buffer = [0u8; 16];
        // SAFETY: as above.
        let len = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                0,
                0,
            )
        };
        assert_eq!(len, 4, "extended attribute was dropped");
        assert_eq!(&buffer[..4], value);
    }

    #[test]
    fn verbatim_paths_are_simplified_to_their_ordinary_form() {
        assert_eq!(
            simplify_verbatim_path(r"\\?\C:\Users\me\a.txt"),
            r"C:\Users\me\a.txt"
        );
        assert_eq!(
            simplify_verbatim_path(r"\\?\UNC\server\share\dir\a.txt"),
            r"\\server\share\dir\a.txt"
        );
        assert_eq!(
            simplify_verbatim_path(r"\\?\Volume{1234}\a.txt"),
            r"\\?\Volume{1234}\a.txt"
        );
        assert_eq!(simplify_verbatim_path("/home/me/a.txt"), "/home/me/a.txt");
    }

    #[test]
    fn rename_changes_letter_case_only() {
        let directory = tempfile::tempdir().expect("temp directory");
        let old = directory.path().join("readme.md");
        let new = directory.path().join("README.md");
        fs::write(&old, b"text").expect("write fixture");

        rename_file_sync(&old, &new).expect("case-only rename");
        let names: Vec<String> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["README.md".to_string()]);
    }

    #[test]
    fn rename_never_replaces_another_file() {
        let directory = tempfile::tempdir().expect("temp directory");
        let old = directory.path().join("a.txt");
        let new = directory.path().join("b.txt");
        fs::write(&old, b"a").unwrap();
        fs::write(&new, b"b").unwrap();

        let error = rename_file_sync(&old, &new).expect_err("destination exists");
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read(&old).unwrap(), b"a");
        assert_eq!(fs::read(&new).unwrap(), b"b");
    }

    #[test]
    fn saving_does_not_wait_for_busy_filesystem_permits() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("local.txt");
        fs::write(&path, b"original").unwrap();
        grant_file(&path);

        tauri::async_runtime::block_on(async {
            // Searches and metadata polls on a hung share hold every permit.
            let mut held = Vec::new();
            for _ in 0..4 {
                held.push(fs_operation_permit().await.unwrap());
            }
            let save = write_file_content(
                path.to_string_lossy().to_string(),
                "changed".into(),
                None,
                None,
                None,
                None,
                None,
            );
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), save).await;
            drop(held);
            assert!(
                matches!(result, Ok(Ok(_))),
                "save waited for the shared permits"
            );
        });
        assert_eq!(fs::read(&path).unwrap(), b"changed");
    }

    #[test]
    fn unrepresentable_windows_1252_save_is_non_destructive() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("encoded.txt");
        fs::write(&path, b"original").expect("write fixture");

        let error = write_file_content_sync(
            path.clone(),
            "emoji: 🙂".to_string(),
            Some("Windows-1252".to_string()),
            None,
            None,
            None,
            false,
        )
        .expect_err("emoji is not representable in Windows-1252");
        assert!(error.starts_with("ZITEXT_ENCODING_UNREPRESENTABLE:"));
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn fifo_is_rejected_without_blocking_in_open() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let directory = tempfile::tempdir().expect("temp directory");
        let fifo = directory.path().join("blocked.fifo");
        let c_path = CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        // SAFETY: c_path is a valid, NUL-terminated path owned for this call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

        let started = std::time::Instant::now();
        assert!(open_regular_file(&fifo).is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn cli_parser_preserves_spaces_and_distinguishes_folders() {
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = directory.path().join("folder with spaces");
        let file = directory.path().join("file with spaces.txt");
        fs::create_dir(&folder).expect("create folder fixture");
        fs::write(&file, b"hello").expect("create file fixture");
        let args = vec![
            "zitext-editor".to_string(),
            folder.to_string_lossy().to_string(),
            file.to_string_lossy().to_string(),
        ];

        let parsed = parse_cli_args(&args, directory.path());
        let expected_folder = clean_path(fs::canonicalize(folder).unwrap());
        assert_eq!(parsed.folder.as_deref(), Some(expected_folder.as_str()));
        assert_eq!(
            parsed.files,
            vec![clean_path(fs::canonicalize(file).unwrap())]
        );
    }

    #[test]
    fn wait_lock_requires_explicit_temp_file_and_is_removed_on_close() {
        let document_dir = tempfile::tempdir().expect("document temp directory");
        let document = document_dir.path().join("wait document.txt");
        fs::write(&document, b"hello").expect("create document fixture");

        let mut lock = tempfile::Builder::new()
            .prefix("zitext-wait.")
            .tempfile_in(std::env::temp_dir())
            .expect("create wait lock");
        lock.write_all(b"pending\n").expect("seed wait lock");
        let lock_path = lock.path().to_path_buf();

        let document_path = clean_path(document);
        register_wait_lock(&document_path, lock_path.to_str().unwrap())
            .expect("register wait lock");
        assert_eq!(fs::read_to_string(&lock_path).unwrap(), "accepted\n");

        release_wait_locks(document_path).unwrap();
        assert!(!lock_path.exists());
    }

    #[test]
    fn wait_lock_follows_a_renamed_or_saved_as_document() {
        let document_dir = tempfile::tempdir().expect("document temp directory");
        let document = document_dir.path().join("before.txt");
        fs::write(&document, b"hello").expect("create document fixture");
        let mut lock = tempfile::Builder::new()
            .prefix("zitext-wait.")
            .tempfile_in(std::env::temp_dir())
            .expect("create wait lock");
        lock.write_all(b"pending\n").expect("seed wait lock");
        let lock_path = lock.path().to_path_buf();
        let old_path = clean_path(document);
        let new_path = clean_path(document_dir.path().join("after.txt"));
        register_wait_lock(&old_path, lock_path.to_str().unwrap()).expect("register wait lock");

        retarget_document(old_path.clone(), new_path.clone());
        release_wait_locks(old_path).unwrap();
        assert!(
            lock_path.exists(),
            "closing another tab with the old path must not release the wait"
        );
        release_wait_locks(new_path).unwrap();
        assert!(!lock_path.exists());
    }

    #[test]
    fn rename_target_keeps_typed_case_and_stays_in_the_folder() {
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = fs::canonicalize(directory.path()).unwrap();
        let old = folder.join("readme.md");
        fs::write(&old, b"text").unwrap();

        let target = rename_target(&old, &folder.join("README.md").to_string_lossy()).unwrap();
        assert_eq!(target, folder.join("README.md"));
        rename_file_sync(&old, &target).expect("case-only rename through the command path");

        let elsewhere = folder.join("sub");
        fs::create_dir(&elsewhere).unwrap();
        assert!(rename_target(&old, &elsewhere.join("x.md").to_string_lossy()).is_err());
        assert!(rename_target(&old, &folder.join("..").to_string_lossy()).is_err());
        assert!(rename_target(&old, &format!("{}/", folder.to_string_lossy())).is_err());
    }

    #[test]
    fn file_names_are_validated() {
        assert!(validate_file_name("notes.md").is_ok());
        assert!(validate_file_name("  ").is_err());
        assert!(validate_file_name("..").is_err());
        assert!(validate_file_name("a/b.txt").is_err());
        assert!(validate_file_name("a\\b.txt").is_err());
        assert!(validate_file_name("a\0b").is_err());
        assert!(validate_file_name(&"x".repeat(256)).is_err());
        if cfg!(windows) {
            assert!(validate_file_name("CON.txt").is_err());
            assert!(validate_file_name("lpt1").is_err());
            assert!(validate_file_name("a:b").is_err());
            assert!(validate_file_name("trailing.").is_err());
        }
    }

    #[test]
    fn save_dialog_default_name_is_reduced_to_a_file_name() {
        assert_eq!(sanitize_default_file_name("notes.md"), "notes.md");
        assert_eq!(sanitize_default_file_name("/etc/passwd"), "passwd");
        assert_eq!(
            sanitize_default_file_name("..\\..\\secret.txt"),
            "secret.txt"
        );
        assert_eq!(sanitize_default_file_name("C:evil.txt"), "Untitled.txt");
        assert_eq!(sanitize_default_file_name("../"), "Untitled.txt");
        assert_eq!(sanitize_default_file_name(""), "Untitled.txt");
    }

    #[cfg(unix)]
    #[test]
    fn opening_through_a_symlink_reports_the_real_path() {
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = fs::canonicalize(directory.path()).unwrap();
        let real = folder.join("real.txt");
        let link = folder.join("link.txt");
        fs::write(&real, b"text").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        grant_file(&real);

        let opened =
            tauri::async_runtime::block_on(read_file_content(link.to_string_lossy().to_string()))
                .expect("read");
        assert_eq!(opened.path, clean_path(real));
    }

    #[test]
    fn open_requests_wait_for_the_renderer_then_flow_as_events() {
        // Before the renderer collects its startup files, requests queue up
        // (a second launch or Finder open used to be emitted into the void).
        assert!(
            queue_until_renderer_ready(vec!["/a.txt".into()], Some("/project".into())).is_none()
        );
        assert!(queue_until_renderer_ready(vec!["/b.txt".into()], None).is_none());
        let files = tauri::async_runtime::block_on(get_startup_args()).unwrap();
        let folder = tauri::async_runtime::block_on(get_startup_folder()).unwrap();
        assert!(files.ends_with(&["/a.txt".to_string(), "/b.txt".to_string()]));
        assert_eq!(folder.as_deref(), Some("/project"));

        let later = queue_until_renderer_ready(vec!["/c.txt".into()], None);
        assert_eq!(later, Some((vec!["/c.txt".to_string()], None)));
    }

    #[test]
    fn unanswered_close_requests_offer_a_way_out() {
        let token = issue_close_request_token();
        assert!(close_request_unanswered(std::time::Duration::ZERO));
        assert!(!close_request_unanswered(std::time::Duration::from_secs(
            60
        )));
        // Repeated clicks reuse the unanswered request (its age keeps growing).
        assert_eq!(
            pending_unacknowledged_close_token().as_deref(),
            Some(token.as_str())
        );
        acknowledge_close_request(token.clone());
        assert!(!close_request_unanswered(std::time::Duration::ZERO));
        assert!(pending_unacknowledged_close_token().is_none());
        assert!(consume_close_request_token(&token));
        assert!(!close_request_unanswered(std::time::Duration::ZERO));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relative_arguments_are_ignored_when_launched_from_the_root() {
        let directory = tempfile::tempdir().expect("temp directory");
        let args = vec!["zitext-editor".to_string(), ".".to_string()];
        let parsed = parse_cli_args(&args, std::path::Path::new("/"));
        assert!(
            parsed.folder.is_none(),
            "\".\" must not open the whole disk"
        );

        let args = vec!["zitext-editor".to_string(), ".".to_string()];
        let parsed = parse_cli_args(&args, directory.path());
        let expected = clean_path(fs::canonicalize(directory.path()).unwrap());
        assert_eq!(parsed.folder.as_deref(), Some(expected.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn wait_lock_outside_the_app_temp_dir_is_accepted_when_owned_by_the_user() {
        use std::os::unix::fs::PermissionsExt;
        // Any folder outside the temp directory; created first in case
        // CARGO_TARGET_DIR points elsewhere.
        let outside_temp = concat!(env!("CARGO_MANIFEST_DIR"), "/target");
        fs::create_dir_all(outside_temp).unwrap();
        let lock_dir = tempfile::tempdir_in(outside_temp).expect("lock directory");
        let lock_path = lock_dir.path().join("zitext-wait.test");
        fs::write(&lock_path, b"pending\n").unwrap();
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600)).unwrap();
        let document_dir = tempfile::tempdir().expect("document directory");
        let document = document_dir.path().join("doc.txt");
        fs::write(&document, b"x").unwrap();
        let document_path = clean_path(fs::canonicalize(&document).unwrap());

        register_wait_lock(&document_path, lock_path.to_str().unwrap()).expect("register");
        release_wait_locks(document_path).unwrap();
        assert!(!lock_path.exists());
    }

    #[test]
    fn find_in_files_searches_extensionless_and_unrecognized_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        // search_file opens each candidate through open_regular_file, which
        // requires an active grant — mirroring what search_in_files's own
        // authorize_path(&folder) call does for the real command.
        grant_folder(directory.path());
        // No extension at all (e.g. a file literally named "90").
        fs::write(
            directory.path().join("90"),
            b"Windows itself does not have a Command Palette",
        )
        .expect("write extensionless fixture");
        // An extension nobody bothered to curate into an allow-list.
        fs::write(
            directory.path().join("notes.qux"),
            b"Windows compatibility notes",
        )
        .expect("write unrecognized-extension fixture");
        // A real binary format must still be skipped.
        fs::write(directory.path().join("icon.png"), b"Windows\0\x89PNG\r\n")
            .expect("write binary fixture");

        let options = SearchOptions {
            query: "Windows",
            case_sensitive: false,
            whole_word: false,
            max_results: 100,
        };
        let mut results = Vec::new();
        let mut budget = SearchBudget::new();
        search_dir_recursive(directory.path(), &options, &mut results, 0, &mut budget);

        let searched: std::collections::HashSet<_> =
            results.iter().map(|m| m.file_path.clone()).collect();
        assert!(searched.iter().any(|p| p.ends_with("90")));
        assert!(searched.iter().any(|p| p.ends_with("notes.qux")));
        assert!(!searched.iter().any(|p| p.ends_with("icon.png")));
    }

    fn search_fixture(
        files: &[(&str, &[u8])],
        query: &str,
        whole_word: bool,
    ) -> (Vec<FileSearchMatch>, SearchBudget) {
        let directory = tempfile::tempdir().expect("temp directory");
        grant_folder(directory.path());
        for (name, bytes) in files {
            fs::write(directory.path().join(name), bytes).expect("write fixture");
        }
        let options = SearchOptions {
            query,
            case_sensitive: false,
            whole_word,
            max_results: 100,
        };
        let mut results = Vec::new();
        let mut budget = SearchBudget::new();
        search_dir_recursive(directory.path(), &options, &mut results, 0, &mut budget);
        (results, budget)
    }

    #[test]
    fn recovery_data_lives_in_its_own_file_and_is_not_rewritten_needlessly() {
        let directory = tempfile::tempdir().expect("temp directory");
        let config = directory.path().join("settings.json");
        let session = directory.path().join("session.json");

        // Older versions kept the session inside settings.json.
        let mut legacy = serde_json::to_value(AppSettings::default()).unwrap();
        legacy["lastSession"] =
            serde_json::to_value(vec![session_file("/p/a.txt".to_string(), false)]).unwrap();
        fs::write(&config, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let mut settings = load_settings_from_path(&config).unwrap();
        assert_eq!(
            settings.last_session.len(),
            1,
            "legacy inline session is still read"
        );

        write_settings_files(&config, &settings).unwrap();
        // settings.json keeps only an empty lastSession, which older versions
        // need in order to read the file after a downgrade.
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
        assert_eq!(written["lastSession"], serde_json::json!([]));
        assert_eq!(
            load_settings_from_path(&config).unwrap().last_session[0].path,
            "/p/a.txt"
        );

        // A settings-only change leaves session.json alone. Writes replace the
        // file atomically, so a rewrite would give it a new identity (more
        // reliable than modification times on coarse filesystems).
        let identity = |path: &std::path::Path| file_identity(path, &fs::metadata(path).unwrap());
        let before = identity(&session);
        settings.recent_files.push("/p/b.txt".to_string());
        write_settings_files(&config, &settings).unwrap();
        assert_eq!(identity(&session), before);

        // A changed session is written (so the check above can fail).
        settings
            .last_session
            .push(session_file("/p/c.txt".to_string(), false));
        write_settings_files(&config, &settings).unwrap();
        assert_ne!(identity(&session), before);
    }

    #[test]
    fn a_file_whose_folder_was_deleted_reports_deleted_not_unauthorized() {
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = fs::canonicalize(directory.path()).unwrap().join("gone");
        fs::create_dir(&folder).unwrap();
        let file = folder.join("notes.txt");
        fs::write(&file, b"x").unwrap();
        grant_file(&file);
        fs::remove_dir_all(&folder).unwrap();

        let path = file.to_string_lossy().to_string();
        let metadata =
            tauri::async_runtime::block_on(get_file_metadata(path.clone())).expect("metadata");
        assert!(!metadata.exists);
        let error = authorize_path(&path).expect_err("cannot write there");
        assert!(error.starts_with(PARENT_MISSING), "{error}");
        // Paths never granted stay plain access denials.
        let other = folder.join("other.txt").to_string_lossy().to_string();
        assert!(authorize_path(&other)
            .unwrap_err()
            .starts_with("Access denied"));
    }

    #[test]
    fn search_counts_lines_like_the_editor() {
        let lines: Vec<_> = editor_lines("a\r\nb\rc\nd").collect();
        assert_eq!(lines, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn misleading_links_are_refused_and_the_destination_is_named() {
        assert!(validate_external_link("https://www.bank.example@evil.example/").is_err());
        assert!(validate_external_link("https://user:pass@example.com/").is_err());
        assert!(
            validate_external_link("mailto:a@example.com?subject=Hi&attach=/etc/passwd").is_err()
        );
        let ok = validate_external_link("mailto:a@example.com?Subject=Hi&body=Text").unwrap();
        assert_eq!(link_destination(&ok), "Email to: a@example.com");
        let web =
            validate_external_link(&format!("https://evil.example/{}", "a".repeat(400))).unwrap();
        assert_eq!(link_destination(&web), "Website: evil.example");
    }

    #[test]
    fn custom_shortcuts_become_menu_accelerators() {
        assert_eq!(
            menu_accelerator("Cmd+Shift+S").as_deref(),
            Some("CmdOrCtrl+Shift+S")
        );
        assert_eq!(
            menu_accelerator("Ctrl+Alt+F").as_deref(),
            Some("CmdOrCtrl+Alt+F")
        );
        assert_eq!(menu_accelerator("Alt+Z").as_deref(), Some("Alt+Z"));
        assert_eq!(menu_accelerator("Ctrl+F5").as_deref(), Some("CmdOrCtrl+F5"));
        assert_eq!(
            menu_accelerator("Ctrl+ArrowUp").as_deref(),
            Some("CmdOrCtrl+Up")
        );
        // Keys a menu can't name keep the default.
        assert_eq!(menu_accelerator("Ctrl+\\"), None);
        assert_eq!(menu_accelerator("Ctrl+"), None);
    }

    #[test]
    fn saved_window_position_is_used_only_when_it_is_on_a_screen() {
        let screen = [(0, 0, 2560, 1440)];
        let state = |x, y, width, height| WindowState {
            x,
            y,
            width,
            height,
            maximized: false,
        };
        assert!(window_state_visible(&state(100, 100, 1200, 800), &screen));
        // On a monitor that is no longer connected.
        assert!(!window_state_visible(&state(3000, 100, 1200, 800), &screen));
        assert!(!window_state_visible(&state(100, -500, 1200, 800), &screen));
        // Absurd sizes.
        assert!(!window_state_visible(&state(100, 100, 50, 50), &screen));
        // Second monitor to the left.
        assert!(window_state_visible(
            &state(-1800, 50, 1200, 800),
            &[(-1920, 0, 1920, 1080), screen[0]]
        ));
    }

    #[test]
    fn closing_a_folder_ends_its_access_but_keeps_open_files() {
        let directory = tempfile::tempdir().expect("temp directory");
        let root = fs::canonicalize(directory.path()).unwrap().join("project");
        fs::create_dir(&root).unwrap();
        let open = root.join("open.txt");
        let other = root.join("other.txt");
        fs::write(&open, b"x").unwrap();
        fs::write(&other, b"y").unwrap();
        grant_folder(&root);

        release_folder_access(
            root.to_string_lossy().to_string(),
            vec![open.to_string_lossy().to_string()],
        );
        assert!(
            authorize_path(&open.to_string_lossy()).is_ok(),
            "an open file stays saveable"
        );
        assert!(
            authorize_path(&other.to_string_lossy()).is_err(),
            "the rest of the folder is closed"
        );
    }

    #[test]
    fn settings_writes_from_the_renderer_keep_the_window_state() {
        let current = AppSettings {
            window_state: Some(WindowState {
                x: 1,
                y: 2,
                width: 1000,
                height: 700,
                maximized: false,
            }),
            ..AppSettings::default()
        };
        let incoming = preserve_authority_settings(AppSettings::default(), &current);
        assert_eq!(incoming.window_state, current.window_state);
    }

    #[test]
    fn a_newer_search_or_count_stops_the_older_one() {
        // Counters of its own: the app's counters are shared with other tests.
        static SEARCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        static COUNTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

        let mut budget = SearchBudget::new();
        budget.supersede = Some(Supersede::claim(&SEARCHES));
        assert!(budget.check());
        Supersede::claim(&SEARCHES);
        assert!(!budget.check(), "superseded search keeps running");

        let count = CountBudget {
            supersede: Supersede::claim(&COUNTS),
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
        };
        assert!(!count.exhausted());
        Supersede::claim(&COUNTS);
        assert!(count.exhausted(), "superseded count keeps running");
    }

    #[test]
    fn huge_folders_are_listed_in_part_instead_of_failing() {
        let directory = tempfile::tempdir().expect("temp directory");
        for index in 0..=MAX_DIRECTORY_ENTRIES {
            fs::write(directory.path().join(format!("f{index}.txt")), b"").unwrap();
        }
        grant_folder(directory.path());
        let listing = tauri::async_runtime::block_on(read_directory(
            directory.path().to_string_lossy().to_string(),
            false,
        ))
        .expect("a big folder still lists");
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), MAX_DIRECTORY_ENTRIES);
    }

    #[cfg(unix)]
    #[test]
    fn skipped_symbolic_links_are_counted_not_hidden_silently() {
        let directory = tempfile::tempdir().expect("temp directory");
        let outside = tempfile::tempdir().expect("outside directory");
        fs::write(outside.path().join("secret.txt"), b"needle").unwrap();
        fs::write(directory.path().join("plain.txt"), b"needle").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("dir-link")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            directory.path().join("file-link.txt"),
        )
        .unwrap();
        grant_folder(directory.path());

        let listing = tauri::async_runtime::block_on(read_directory(
            directory.path().to_string_lossy().to_string(),
            false,
        ))
        .expect("folder lists");
        assert_eq!(listing.entries.len(), 1, "links stay out of the explorer");
        assert_eq!(listing.hidden_links, 2);

        let options = SearchOptions {
            query: "needle",
            case_sensitive: false,
            whole_word: false,
            max_results: 100,
        };
        let mut results = Vec::new();
        let mut budget = SearchBudget::new();
        search_dir_recursive(directory.path(), &options, &mut results, 0, &mut budget);
        assert_eq!(results.len(), 1, "links are not followed");
        assert_eq!(budget.skipped_links, 2);
    }

    /// File-name searches supersede each other (a newer query stops an older
    /// one), so tests that run them take turns instead of cutting each
    /// other short when the test harness runs them in parallel.
    static NAME_SEARCH_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn name_search_turn() -> std::sync::MutexGuard<'static, ()> {
        NAME_SEARCH_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn file_name_search_reaches_unexpanded_folders() {
        let _turn = name_search_turn();
        let directory = tempfile::tempdir().expect("temp directory");
        let root = fs::canonicalize(directory.path()).unwrap();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/deep/Target.ts"), b"").unwrap();
        fs::write(root.join("node_modules/pkg/target.js"), b"").unwrap();
        fs::write(root.join("other.ts"), b"").unwrap();
        grant_folder(&root);

        let result = tauri::async_runtime::block_on(find_files_by_name(
            root.to_string_lossy().to_string(),
            "target".to_string(),
        ))
        .unwrap();
        let paths: Vec<_> = result
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        assert!(paths.contains(&clean_path(root.join("src/deep/Target.ts"))));
        assert!(paths.contains(&clean_path(root.join("src/deep"))));
        assert!(paths.contains(&clean_path(root.join("src"))));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert!(!paths.iter().any(|path| path.ends_with("other.ts")));
        assert!(!result.truncated);
    }

    #[test]
    fn case_insensitive_search_finds_a_word_final_sigma() {
        // str::to_lowercase turns a final Σ into ς; the text is lower-cased
        // per character (σ), so the query must be too.
        let (results, _) = search_fixture(&[("greek.txt", "ΟΔΟΣ".as_bytes())], "ΟΔΟΣ", false);
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn file_name_search_skips_deep_folders_without_stopping() {
        let _turn = name_search_turn();
        let directory = tempfile::tempdir().expect("temp directory");
        let root = fs::canonicalize(directory.path()).unwrap();
        let mut deep = root.join("a");
        for level in 0..=MAX_DIRECTORY_DEPTH {
            deep = deep.join(format!("d{level}"));
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(root.join("z-target.txt"), b"").unwrap();
        grant_folder(&root);
        let result = tauri::async_runtime::block_on(find_files_by_name(
            root.to_string_lossy().to_string(),
            "target".to_string(),
        ))
        .unwrap();
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("z-target.txt")));
        assert!(!result.truncated);
    }

    #[test]
    fn recovery_keeps_unsaved_work_whose_folder_was_deleted() {
        let directory = tempfile::tempdir().expect("temp directory");
        let folder = fs::canonicalize(directory.path()).unwrap().join("gone");
        fs::create_dir(&folder).unwrap();
        let file = folder.join("draft.txt");
        fs::write(&file, b"x").unwrap();
        grant_file(&file);
        fs::remove_dir_all(&folder).unwrap();

        let mut entry = session_file(file.to_string_lossy().to_string(), false);
        entry.is_dirty = true;
        entry.content = Some("unsaved".to_string());
        let mut session = vec![entry];
        validate_session_entries(&mut session, None);
        assert_eq!(session.len(), 1);
        assert_eq!(session[0].content.as_deref(), Some("unsaved"));
    }

    #[test]
    fn case_insensitive_matches_keep_their_position_after_expanding_characters() {
        // "İ" lower-cases to two characters; the highlight must not shift.
        let (results, _) = search_fixture(&[("city.txt", "İstanbul foo".as_bytes())], "FOO", false);
        assert_eq!(results.len(), 1);
        assert_eq!((results[0].match_start, results[0].match_end), (9, 12));

        let (results, _) = search_fixture(&[("city.txt", "İİ foo İfoo".as_bytes())], "foo", true);
        assert_eq!(results.len(), 1, "whole word: only the standalone foo");
        assert_eq!((results[0].match_start, results[0].match_end), (3, 6));
    }

    #[test]
    fn windows_1252_files_are_searched_and_skips_are_reported() {
        let large = vec![b'a'; (LARGE_FILE_WARNING + 1) as usize];
        let (results, budget) = search_fixture(
            &[
                ("latin.txt", b"caf\xE9 menu"),
                ("utf16.txt", b"\xFF\xFEm\0e\0n\0u\0"),
                ("huge.txt", &large),
            ],
            "menu",
            false,
        );
        assert!(results.iter().any(|m| m.file_path.ends_with("latin.txt")));
        assert_eq!(budget.skipped_encoding, 1);
        assert_eq!(budget.skipped_large, 1);

        let report = search_report(results, &budget);
        assert!(!report.result_limit_reached);
        assert_eq!(report.skipped_large_files, 1);
    }
}
