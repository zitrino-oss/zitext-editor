use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
static STARTUP_FOLDER: OnceLock<Option<String>> = OnceLock::new();
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

/// Per-search budget: a worst-case query on a deep tree could otherwise read
/// tens of thousands of files. We cap files visited and total wall-clock time.
struct SearchBudget {
    files_visited: u32,
    response_bytes: usize,
    started_at: std::time::Instant,
    /// Set true when any limit fires so the caller can surface partial results.
    stopped: bool,
}

impl SearchBudget {
    fn new() -> Self {
        Self {
            files_visited: 0,
            response_bytes: 0,
            started_at: std::time::Instant::now(),
            stopped: false,
        }
    }

    /// Returns true if the search should keep going.
    fn check(&mut self) -> bool {
        if self.stopped {
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

#[cfg(windows)]
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
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
        return Err(
            "Access denied: this path has not been opened or saved in this session. \
             Open it via File → Open or by dragging it into the window."
                .to_string(),
        );
    }
    Ok(validated)
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

/// Strips the \\?\ prefix that canonicalize() adds on Windows.
/// This prefix often causes issues with frontend path matching.
fn clean_path(path: PathBuf) -> String {
    let path_str = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    path_str
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
    #[serde(default)]
    keybindings: HashMap<String, String>,
    #[serde(default)]
    sort_json_keys: bool,
    #[serde(default)]
    opened_folder: Option<String>,
    #[serde(default = "default_sidebar_width")]
    sidebar_width: u32,
    #[serde(default)]
    sidebar_collapsed: bool,
    #[serde(default)]
    active_tab_path: Option<String>,
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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            // Default to Menlo. It's an Apple-only system font, so the chain
            // falls back to Consolas (Windows) and the bundled JetBrains Mono
            // (Linux / guaranteed everywhere) where Menlo isn't present.
            font_family: "\"Menlo\", \"Consolas\", \"JetBrains Mono\", monospace".to_string(),
            font_size: 14,
            word_wrap: false,
            recent_files: Vec::new(),
            last_session: Vec::new(),
            autosave: "off".to_string(),
            autosave_delay: 2000,
            show_minimap: false,
            editor_theme: "vs-dark".to_string(),
            keybindings: HashMap::new(),
            sort_json_keys: false,
            opened_folder: None,
            sidebar_width: 250,
            sidebar_collapsed: false,
            active_tab_path: None,
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

/// Writes a complete file through a same-directory temporary file and then
/// atomically replaces the destination. The temporary file is create-new,
/// inherits the destination's permissions when one exists, and is flushed
/// before publication.
fn atomic_write_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Destination has no parent directory".to_string())?;

    let destination_metadata = fs::metadata(path).ok();
    let mut builder = tempfile::Builder::new();
    builder.prefix(".zitext-write-");
    #[cfg(unix)]
    if destination_metadata.is_none() {
        use std::os::unix::fs::PermissionsExt;
        // Match normal file creation semantics (0666 & !umask), rather than
        // tempfile's owner-only default, for a newly-created user document.
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let mut temp = builder
        .tempfile_in(parent)
        .map_err(|e| format!("Failed to create temporary file: {e}"))?;

    if let Some(metadata) = destination_metadata {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| format!("Failed to preserve file permissions: {e}"))?;
    }

    temp.write_all(bytes)
        .map_err(|e| format!("Failed to write temporary file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to flush temporary file: {e}"))?;
    temp.persist(path)
        .map_err(|e| format!("Failed to replace destination file: {}", e.error))?;

    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Failed to flush destination directory: {e}"))?;
    }

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

    let (tx, mut rx) = tokio::sync::mpsc::channel(1);

    app.dialog().file().pick_file(move |file_path| {
        let _ = tx.blocking_send(file_path.map(|p| p.to_string()));
    });

    match tokio::time::timeout(tokio::time::Duration::from_secs(300), rx.recv()).await {
        Ok(Some(result)) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            grant_file(&pb);
            clean_path(pb)
        })),
        Ok(None) => Ok(None),
        Err(_) => Err("Dialog timeout".to_string()),
    }
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

    let (tx, mut rx) = tokio::sync::mpsc::channel(1);

    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |file_path| {
            let _ = tx.blocking_send(file_path.map(|p| p.to_string()));
        });

    match tokio::time::timeout(tokio::time::Duration::from_secs(300), rx.recv()).await {
        Ok(Some(result)) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            grant_file(&pb);
            clean_path(pb)
        })),
        Ok(None) => Ok(None),
        Err(_) => Err("Dialog timeout".to_string()),
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
    if metadata.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({:.1} MB). Maximum supported size is {} MB",
            metadata.len() as f64 / 1_048_576.0,
            MAX_FILE_SIZE / 1_048_576
        ));
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

    // Binary detection: check the first 8 KB for null bytes.
    let check_len = bytes.len().min(8192);
    if bytes[..check_len].contains(&0u8) {
        return Err("This file appears to be binary. ZITEXT is a text editor and cannot display binary content.".to_string());
    }

    let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(&bytes);
    if had_errors {
        dlog!("UTF-8 decoding had errors, trying WINDOWS_1252");
        let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&bytes);
        Ok(FileReadResult {
            content: decoded.into_owned(),
            size,
            encoding: "Windows-1252".to_string(),
            modified,
            hash,
            identity: file_identity(&validated_path, &metadata),
        })
    } else {
        dlog!("File decoded successfully as UTF-8");
        Ok(FileReadResult {
            content: decoded.into_owned(),
            size,
            encoding: "UTF-8".to_string(),
            modified,
            hash,
            identity: file_identity(&validated_path, &metadata),
        })
    }
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

    let requested_encoding = encoding.unwrap_or_else(|| "UTF-8".to_string());
    let (bytes, saved_encoding) = if requested_encoding.eq_ignore_ascii_case("windows-1252") {
        let (encoded, _, had_errors) = encoding_rs::WINDOWS_1252.encode(&content);
        if had_errors {
            return Err(
                "ZITEXT_ENCODING_UNREPRESENTABLE: this document contains characters that cannot be represented in Windows-1252."
                    .to_string(),
            );
        }
        (encoded.into_owned(), "Windows-1252".to_string())
    } else {
        (content.into_bytes(), "UTF-8".to_string())
    };

    atomic_write_file(&validated_path, &bytes).map_err(|e| {
        dlog!("File write error: {}", e);
        format!("Failed to write file: {e}")
    })?;

    let metadata =
        fs::metadata(&validated_path).map_err(|e| format!("Failed to inspect saved file: {e}"))?;
    Ok(FileWriteResult {
        encoding: saved_encoding,
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
) -> Result<FileWriteResult, String> {
    let _operation_permit = fs_operation_permit().await?;
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

    if content.len() > MAX_FILE_SIZE as usize {
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

    if !config_path.exists() {
        return Ok(AppSettings::default());
    }

    if let Ok(metadata) = fs::metadata(&config_path) {
        if metadata.len() > MAX_SETTINGS_BYTES as u64 {
            quarantine_settings_file(&config_path, "oversized");
            return Ok(AppSettings::default());
        }
    }

    let content =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read settings: {}", e))?;

    match serde_json::from_str(&content) {
        Ok(settings) => Ok(settings),
        Err(_error) => {
            dlog!("Recovering corrupt settings file: {}", _error);
            quarantine_settings_file(&config_path, "corrupt");
            Ok(AppSettings::default())
        }
    }
}

fn quarantine_settings_file(config_path: &std::path::Path, reason: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let backup = config_path.with_file_name(format!("settings.{reason}.{timestamp}.json"));
    let _ = fs::rename(config_path, backup);
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

    // Create parent directory if it doesn't exist
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    if json.len() > MAX_SETTINGS_BYTES {
        return Err(format!(
            "Settings and recovery data exceed the {} MB limit",
            MAX_SETTINGS_BYTES / 1_048_576
        ));
    }

    atomic_write_file(&config_path, json.as_bytes())
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
    incoming
}

#[tauri::command]
async fn get_recent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let settings = load_settings(app).await?;
    Ok(settings.recent_files)
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
    let active_tab_path = validate_session_entries(&mut session, active_tab_path)?;

    let _guard = settings_lock().lock().await;
    let mut settings = load_settings(app.clone()).await?;
    settings.last_session = session;
    settings.active_tab_path = active_tab_path;
    write_settings_to_disk(app, settings).await
}

fn validate_session_entries(
    session: &mut [SessionFile],
    active_tab_path: Option<String>,
) -> Result<Option<String>, String> {
    if session.len() > MAX_SESSION_FILES {
        return Err(format!(
            "Session contains too many tabs (maximum {MAX_SESSION_FILES})"
        ));
    }

    let mut total_content_bytes = 0usize;
    for entry in session.iter_mut() {
        if entry.path.len() > 32 * 1024 {
            return Err("Session path is too long".to_string());
        }
        if let Some(content) = entry.content.as_ref() {
            if content.len() > MAX_SESSION_CONTENT_BYTES {
                return Err(format!(
                    "A recovery buffer exceeds the {} MB limit",
                    MAX_SESSION_CONTENT_BYTES / 1_048_576
                ));
            }
            total_content_bytes = total_content_bytes
                .checked_add(content.len())
                .ok_or_else(|| "Session content size overflow".to_string())?;
        }

        if !entry.is_untitled {
            let authorized = authorize_path(&entry.path)?;
            entry.path = clean_path(authorized);
        }
    }
    if total_content_bytes > MAX_SESSION_TOTAL_BYTES {
        return Err(format!(
            "Session recovery data exceed the {} MB limit",
            MAX_SESSION_TOTAL_BYTES / 1_048_576
        ));
    }

    let active_tab_path = match active_tab_path {
        Some(path) => {
            let authorized = authorize_path(&path)?;
            let clean = clean_path(authorized);
            if !session
                .iter()
                .any(|entry| !entry.is_untitled && entry.path == clean)
            {
                return Err("Active tab is not part of the saved session".to_string());
            }
            Some(clean)
        }
        None => None,
    };

    Ok(active_tab_path)
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
    // 30s timeout safety net: if the prompt callback never fires (Tauri
    // dialog plugin edge case), fall through to "skip" rather than hang the
    // renderer's init sequence indefinitely.
    let restore = tokio::time::timeout(std::time::Duration::from_secs(30), wait_session_decision())
        .await
        .unwrap_or(false);

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
    // Mark that the frontend has consumed startup args.
    // Any RunEvent::Opened arriving after this will be emitted as events instead.
    STARTUP_ARGS_CONSUMED
        .get_or_init(|| std::sync::atomic::AtomicBool::new(false))
        .store(true, std::sync::atomic::Ordering::SeqCst);

    let args = STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    let files = args
        .lock()
        .map(|mut v| std::mem::take(&mut *v))
        .unwrap_or_default();
    Ok(files)
}

#[tauri::command]
async fn get_startup_folder() -> Result<Option<String>, String> {
    Ok(STARTUP_FOLDER.get().cloned().unwrap_or(None))
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
        } else {
            cwd.join(argument)
        };
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
    if !canonical.starts_with(&temp) || !valid_name {
        return Err("--wait lock must be a zitext-wait.* file in the temp directory".to_string());
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

/// Signals that a tab with the given path was closed.
/// If a --wait lock file exists for this path, it is deleted so the CLI unblocks.
#[tauri::command]
fn signal_tab_closed(path: String) -> Result<(), String> {
    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut map) = locks.lock() {
        if let Some(lock_paths) = map.remove(&path) {
            // Stored lock paths went through `clean_path` (which strips the
            // Windows `\\?\` verbatim prefix); normalize `temp` the same way
            // so the `starts_with` check below can actually match.
            let temp = std::env::temp_dir()
                .canonicalize()
                .ok()
                .map(|p| PathBuf::from(clean_path(p)));
            for lock_path in lock_paths {
                // register_wait_lock already canonicalized and validated these;
                // retain a final temp-directory check before deletion.
                let lock = PathBuf::from(&lock_path);
                if temp.as_ref().is_some_and(|root| lock.starts_with(root)) {
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
    // See the matching comment in `signal_tab_closed`: normalize the same way
    // `clean_path` normalized the stored lock paths.
    let temp = std::env::temp_dir()
        .canonicalize()
        .ok()
        .map(|p| PathBuf::from(clean_path(p)));
    for lock_path in map.drain().flat_map(|(_, paths)| paths) {
        let lock = PathBuf::from(&lock_path);
        if temp.as_ref().is_some_and(|root| lock.starts_with(root)) {
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

    match tokio::time::timeout(tokio::time::Duration::from_secs(300), rx).await {
        Ok(Ok(result)) => Ok(result.map(|p| {
            let pb = PathBuf::from(p);
            // User picked a folder — grant recursively so read_directory,
            // read_file_content of children, search_in_files etc. all work.
            grant_folder(&pb);
            clean_path(pb)
        })),
        Ok(Err(_)) => Ok(None), // sender dropped without sending (dialog closed internally)
        Err(_) => Err("Dialog timeout".to_string()),
    }
}

#[tauri::command]
async fn read_directory(path: String, recursive: bool) -> Result<Vec<FileEntry>, String> {
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

        // Check entry count limit
        if *entry_count > MAX_DIRECTORY_ENTRIES {
            return Err(format!(
                "Directory entry limit ({}) exceeded. Too many files in directory tree.",
                MAX_DIRECTORY_ENTRIES
            ));
        }

        let mut entries = Vec::new();

        let dir_entries =
            fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in dir_entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();

            // Skip symlinks — prevents escaping the intended directory tree via
            // crafted or malicious symlinks.
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.file_type().is_symlink() => Some(metadata),
                _ => continue,
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

            *entry_count += 1;

            // Enforce the cap inside the loop so a single huge flat directory
            // cannot blow past the limit. The pre-loop check above only fires
            // on recursive entry — without this, a 100k-entry folder would
            // allocate/return all entries before the next recursion step.
            if *entry_count > MAX_DIRECTORY_ENTRIES {
                return Err(format!(
                    "Directory entry limit ({}) exceeded. Too many files in directory tree.",
                    MAX_DIRECTORY_ENTRIES
                ));
            }

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
                if let Ok(mut sub_entries) = read_dir_recursive(&path, true, depth + 1, entry_count)
                {
                    entries.append(&mut sub_entries);
                }
            }
        }

        Ok(entries)
    }

    tokio::task::spawn_blocking(move || {
        let mut entry_count = 0;
        read_dir_recursive(&validated_path, recursive, 0, &mut entry_count)
    })
    .await
    .map_err(|e| format!("Directory worker failed: {e}"))?
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
    let validated_path = authorize_path(&path)?;

    let metadata = match fs::symlink_metadata(&validated_path) {
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
        identity: file_identity(&validated_path, &metadata),
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

    let mut results = Vec::new();

    for path in paths {
        // Skip unauthorized paths silently — file watchers commonly poll
        // currently-open files, and unauthorized entries here just shouldn't
        // surface metadata. Failing the whole batch would hide legit changes.
        let validated_path = match authorize_path(&path) {
            Ok(p) => p,
            Err(_) => continue,
        };

        match fs::symlink_metadata(&validated_path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                if let Some(modified) = modified_millis(&metadata) {
                    results.push(FileMetadataWithPath {
                        path,
                        modified,
                        size: metadata.len(),
                        exists: true,
                        identity: file_identity(&validated_path, &metadata),
                    });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                results.push(FileMetadataWithPath {
                    path,
                    modified: 0,
                    size: 0,
                    exists: false,
                    identity: String::new(),
                });
            }
            Ok(_) => {
                results.push(FileMetadataWithPath {
                    path,
                    modified: 0,
                    size: 0,
                    exists: false,
                    identity: String::new(),
                });
            }
            Err(_error) => {
                // Transient permission/I/O errors are not deletions. Omit this
                // sample so the watcher retries it on the next poll.
                dlog!("Failed to poll metadata for {}: {}", path, _error);
            }
        }
    }

    Ok(results)
}

#[tauri::command]
async fn rebuild_native_menu(app: tauri::AppHandle) -> Result<(), String> {
    let settings = load_settings(app.clone()).await?;
    let menu = build_app_menu(&app, settings.recent_files)
        .map_err(|e| format!("Failed to build menu: {}", e))?;
    app.set_menu(menu)
        .map_err(|e| format!("Failed to set menu: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let _operation_permit = fs_operation_permit().await?;
    // Both endpoints must be authorized. Typical rename happens inside an
    // open folder, so a single recursive folder grant covers both. For a
    // cross-folder rename, the user would have needed grants on both sides.
    let validated_old = authorize_path(&old_path)?;
    let validated_new = authorize_path(&new_path)?;
    if !validated_old.is_file() {
        return Err("Only regular files can be renamed".to_string());
    }

    // hard_link creates the destination with no-replace semantics on all
    // supported desktop filesystems. Removing the old link completes the
    // rename; a crash between the operations can leave two names but cannot
    // destroy either file.
    fs::hard_link(&validated_old, &validated_new).map_err(|e| {
        format!(
            "Failed to safely rename the file without overwriting the destination. \
                 The destination may already exist, or this filesystem may not support \
                 safe hard-link renames; use Save As if needed: {e}"
        )
    })?;
    if let Err(error) = fs::remove_file(&validated_old) {
        let _ = fs::remove_file(&validated_new);
        return Err(format!("Failed to remove the old filename: {error}"));
    }
    // Transfer any explicit file-grant on the old path to the new path so
    // subsequent reads/writes against the renamed file keep working.
    revoke_file_grant(&validated_old);
    grant_file(&validated_new);
    Ok(())
}

/// Builds the native app menu — used on all desktop platforms so file dialogs
/// can be triggered via real menu/keyboard gestures rather than purely from
/// the renderer. The menu is the canonical entry point; `request_menu_action`
/// (the only renderer-callable dialog command) routes through the same logic.
fn build_app_menu(
    handle: &tauri::AppHandle,
    recent_files: Vec<String>,
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    // Standard App Menu
    let app_menu = Submenu::with_id(handle, "app", "ZITEXT", true)?;

    // File Menu
    let file_menu = Submenu::with_id(handle, "file", "File", true)?;
    let m_new = MenuItem::with_id(handle, "new", "New", true, Some("CmdOrCtrl+N"))?;
    let m_open = MenuItem::with_id(handle, "open", "Open File...", true, Some("CmdOrCtrl+O"))?;
    let m_open_folder =
        MenuItem::with_id(handle, "open_folder", "Open Folder...", true, None::<&str>)?;

    file_menu.append(&m_new)?;
    file_menu.append(&m_open)?;
    file_menu.append(&m_open_folder)?;
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

    let m_save = MenuItem::with_id(handle, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let m_save_as = MenuItem::with_id(
        handle,
        "save_as",
        "Save As...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let m_revert = MenuItem::with_id(handle, "revert_file", "Revert File", true, None::<&str>)?;
    let m_close = MenuItem::with_id(handle, "close", "Close Tab", true, Some("CmdOrCtrl+W"))?;

    file_menu.append(&m_save)?;
    file_menu.append(&m_save_as)?;
    file_menu.append(&m_revert)?;
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
    let m_find = MenuItem::with_id(handle, "find", "Find...", true, Some("CmdOrCtrl+F"))?;
    let m_replace = MenuItem::with_id(
        handle,
        "replace",
        "Find & Replace...",
        true,
        Some("CmdOrCtrl+H"),
    )?;
    let m_find_in_files = MenuItem::with_id(
        handle,
        "find_in_files",
        "Find in Files...",
        true,
        Some("CmdOrCtrl+Shift+F"),
    )?;
    let m_goto = MenuItem::with_id(handle, "goto", "Go to Line...", true, Some("CmdOrCtrl+G"))?;
    edit_menu.append(&m_find)?;
    edit_menu.append(&m_replace)?;
    edit_menu.append(&m_find_in_files)?;
    edit_menu.append(&m_goto)?;

    // View Menu
    let view_menu = Submenu::with_id(handle, "view", "View", true)?;
    let m_theme = MenuItem::with_id(
        handle,
        "toggle_theme",
        "Toggle Theme (Dark/Light)",
        true,
        None::<&str>,
    )?;
    let m_wrap = MenuItem::with_id(
        handle,
        "toggle_wrap",
        "Toggle Word Wrap",
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
        ("lang-sass", "Sass"),
        ("lang-less", "Less"),
        ("lang-coffeescript", "CoffeeScript"),
        ("lang-handlebars", "Handlebars"),
        ("lang-pug", "Pug"),
        ("lang-razor", "Razor"),
        ("lang-twig", "Twig"),
        ("lang-markdown", "Markdown"),
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
        ("lang-groovy", "Groovy"),
        ("lang-haskell", "Haskell"),
        ("lang-julia", "Julia"),
        ("lang-lua", "Lua"),
        ("lang-perl", "Perl"),
        ("lang-r", "R"),
        ("lang-scala", "Scala"),
        ("lang-scheme", "Scheme"),
        ("lang-fsharp", "F#"),
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
        ("lang-fortran", "Fortran"),
        ("lang-pascal", "Pascal"),
        ("lang-ocaml", "OCaml"),
        ("lang-verilog", "Verilog"),
        ("lang-vhdl", "VHDL"),
        ("lang-solidity", "Solidity"),
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
        ("lang-makefile", "Makefile"),
        ("lang-latex", "LaTeX"),
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
            &lang_menu,
            &settings_menu,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

// ============================================================================
// Find in Files commands
// ============================================================================

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
    let (file, _) = match open_regular_file(path) {
        Ok(opened) if opened.1.len() <= LARGE_FILE_WARNING => opened,
        _ => return,
    };
    let content = match read_bounded(file).and_then(|bytes| {
        String::from_utf8(bytes).map_err(|_| "Search file is not UTF-8".to_string())
    }) {
        Ok(content) => content,
        Err(_) => return,
    };

    let needle = if options.case_sensitive {
        options.query.to_string()
    } else {
        options.query.to_lowercase()
    };

    for (line_idx, line) in content.lines().enumerate() {
        if results.len() >= options.max_results {
            break;
        }

        let haystack = if options.case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };

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

                    let ok = if options.whole_word {
                        // Use byte-slicing then chars().last()/next() — correct for
                        // multi-byte UTF-8 and O(n) only over the slice, not the full line.
                        let before_ok = abs_start == 0
                            || !haystack[..abs_start]
                                .chars()
                                .last()
                                .map(|c| c.is_alphanumeric() || c == '_')
                                .unwrap_or(false);
                        let after_ok = abs_end >= haystack.len()
                            || !haystack[abs_end..]
                                .chars()
                                .next()
                                .map(|c| c.is_alphanumeric() || c == '_')
                                .unwrap_or(false);
                        before_ok && after_ok
                    } else {
                        true
                    };

                    if ok {
                        // Convert byte offsets in `haystack` to UTF-16 code-unit
                        // offsets in the original `line`.  JavaScript strings are
                        // UTF-16, so `.slice(start, end)` needs UTF-16 indices.
                        // 1. How many Unicode chars precede the match in haystack?
                        let char_start = haystack[..abs_start].chars().count();
                        let char_end = haystack[..abs_end].chars().count();
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

fn search_dir_recursive(
    dir: &std::path::Path,
    options: &SearchOptions<'_>,
    results: &mut Vec<FileSearchMatch>,
    depth: usize,
    budget: &mut SearchBudget,
) {
    if depth > MAX_DIRECTORY_DEPTH || results.len() >= options.max_results || !budget.check() {
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

        // Skip symlinks — prevents following crafted symlinks outside the search root.
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
            _ => continue,
        };

        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Do not skip dotfiles — .bashrc, .gitignore, .env, etc. are valid search targets.
        // Specific large/binary dot-directories (.git, .venv, …) are excluded below.

        if metadata.file_type().is_dir() {
            // Skip well-known large or generated directories (build output, caches, VCS
            // data, etc.). These hold machine-generated files that would otherwise flood
            // results and exhaust the match cap / visit budget before real source files
            // are reached — e.g. a Next.js `.next` folder buried product-icons.tsx entirely.
            if matches!(
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
            ) {
                continue;
            }
            search_dir_recursive(&path, options, results, depth + 1, budget);
        } else if metadata.file_type().is_file() && is_text_file(&path) {
            search_file(&path, options, results, budget);
        }
    }
}

#[tauri::command]
async fn search_in_files(
    folder: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Vec<FileSearchMatch>, String> {
    let _operation_permit = fs_operation_permit().await?;
    if query.is_empty() {
        return Ok(Vec::new());
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
        let options = SearchOptions {
            query: &query,
            case_sensitive,
            whole_word,
            max_results: MAX_SEARCH_RESULTS,
        };
        search_dir_recursive(&validated_folder, &options, &mut results, 0, &mut budget);
        results
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
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("crash.log");

    // Rotate if file exceeds 1 MB
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 1_048_576 {
            let old = log_dir.join("crash.log.old");
            let _ = fs::rename(&log_path, &old);
        }
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open crash.log: {e}"))?;
    writeln!(file, "{}", line).map_err(|e| format!("Failed to write crash.log: {e}"))?;
    Ok(())
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
#[tauri::command]
fn open_url_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("zitext.com") {
        return Err("Only https://zitext.com URLs are permitted".to_string());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Failed to open URL: {e}"))
}

// ============================================================================
// App-close confirmation
// ============================================================================

/// Set once the user has resolved unsaved changes (or there were none). The
/// window/exit handlers check this so a confirmed close is allowed through
/// instead of being intercepted again.
static CLOSE_CONFIRMED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
static CLOSE_REQUEST_TOKEN: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();
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
        *pending = Some(token.clone());
    }
    token
}

fn consume_close_request_token(token: &str) -> bool {
    let Ok(mut pending) = CLOSE_REQUEST_TOKEN
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
    else {
        return false;
    };
    if pending.as_deref() == Some(token) {
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
) -> Result<(), String> {
    if !consume_close_request_token(&token) {
        return Err("No matching native close request is pending".to_string());
    }
    close_confirmed().store(true, std::sync::atomic::Ordering::SeqCst);
    // Clear the saved session synchronously so the next launch starts fresh.
    // This replaces the renderer's fire-and-forget beforeunload clear, which
    // could race teardown and leave a stale session (spurious restore prompt).
    // Crash/kill paths skip this and still restore from the periodic snapshot.
    {
        let _guard = settings_lock().lock().await;
        if let Ok(mut settings) = load_settings(app.clone()).await {
            settings.last_session = Vec::new();
            settings.active_tab_path = None;
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

/// Criterion entry points that deliberately reuse the production authority,
/// no-follow, bounded-read, decoding, and atomic-write implementations.
/// They are not Tauri commands and do not expand the renderer IPC surface.
#[doc(hidden)]
pub mod benchmark_support {
    use super::*;

    pub fn authorize_for_benchmark(path: &std::path::Path) -> Result<PathBuf, String> {
        grant_file(path);
        authorize_path(&path.to_string_lossy())
    }

    pub fn read_authorized_text(path: &std::path::Path) -> Result<usize, String> {
        let authorized = authorize_for_benchmark(path)?;
        let (file, _) = open_regular_file(&authorized)?;
        let bytes = read_bounded(file)?;
        let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(&bytes);
        if had_errors {
            Ok(encoding_rs::WINDOWS_1252.decode(&bytes).0.len())
        } else {
            Ok(decoded.len())
        }
    }

    pub fn write_authorized_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
        let authorized = authorize_for_benchmark(path)?;
        atomic_write_file(&authorized, bytes)
    }
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
            let log_path = dirs.join("com.zitrino.zitext").join("crash.log");
            if let Ok(mut f) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
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

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            dlog!("Secondary instance launched with args: {:?}", args);
            let parsed = parse_cli_args(&args, std::path::Path::new(&cwd));
            for (file_path, lock_path) in &parsed.wait_locks {
                let _ = register_wait_lock(file_path, lock_path);
            }
            if let Some(folder) = parsed.folder {
                let _ = app.emit("open-folder", folder);
            }
            for file in parsed.files {
                let _ = app.emit("open-file", file);
            }

            let _ = app
                .get_webview_window("main")
                .or_else(|| app.webview_windows().values().next().cloned())
                .map(|w| w.set_focus());
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            start_wait_lock_heartbeat();
            // Native menubar stays macOS-only. Windows/Linux render an in-app
            // <MenuBar> React component instead — adding a native menubar
            // there would duplicate the UI. The Layer-1 protection (renderer
            // cannot invoke dialog primitives directly) holds regardless,
            // because `request_menu_action` is the only renderer-callable
            // dialog entry on every platform.
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle();
                let menu = build_app_menu(handle, Vec::new())?;
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
                            let token = issue_close_request_token();
                            let _ = event_win.emit("close-requested", token);
                        }
                    }
                    tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                        for p in paths {
                            if p.is_dir() {
                                grant_folder(p);
                                let _ =
                                    event_win.emit("open-folder", p.to_string_lossy().to_string());
                            } else if p.is_file() {
                                grant_file(p);
                                let _ =
                                    event_win.emit("open-file", p.to_string_lossy().to_string());
                            }
                        }
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
                    v.extend(startup_files.clone());
                }
            }
            let _ = STARTUP_FOLDER.set(startup_folder.clone());

            if !startup_files.is_empty() || startup_folder.is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                    if let Some(folder) = startup_folder {
                        let _ = handle.emit("open-folder", folder);
                    }
                    for file in startup_files {
                        let _ = handle.emit("open-file", file);
                    }
                });
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
            // Directory and file-metadata commands
            read_directory,
            get_file_metadata,
            get_files_metadata,
            rename_file,
            rebuild_native_menu,
            // Find in Files commands
            search_in_files,
            append_crash_log,
            open_url_in_browser,
            set_window_theme,
            grant_recent_path,
            confirm_app_close,
            cancel_app_close,
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
                        if let Some(w) = app_handle
                            .get_webview_window("main")
                            .or_else(|| app_handle.webview_windows().values().next().cloned())
                        {
                            let token = issue_close_request_token();
                            let _ = w.emit("close-requested", token);
                        }
                    }
                }
                tauri::RunEvent::Exit => cleanup_wait_locks(),
                // Handle files opened via macOS Finder ("Open With" / file
                // associations). RunEvent::Opened only exists on macOS.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let handle = app_handle.clone();
                    let paths: Vec<String> = urls
                        .iter()
                        .filter(|u: &&url::Url| u.scheme() == "file")
                        .filter_map(|u: &url::Url| u.to_file_path().ok())
                        .map(|p: std::path::PathBuf| p.to_string_lossy().to_string())
                        .filter(|p: &String| std::path::Path::new(p).exists())
                        .collect();

                    if !paths.is_empty() {
                        // macOS "Open With ZITEXT" → grant before forwarding,
                        // whether the renderer is ready now or these queue.
                        for p in &paths {
                            grant_file(std::path::Path::new(p));
                        }

                        let consumed = STARTUP_ARGS_CONSUMED
                            .get_or_init(|| std::sync::atomic::AtomicBool::new(false))
                            .load(std::sync::atomic::Ordering::SeqCst);

                        if consumed {
                            tauri::async_runtime::spawn(async move {
                                for path in paths {
                                    let _ = handle.emit("open-file", path);
                                }
                            });
                        } else {
                            let args_store =
                                STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
                            if let Ok(mut v) = args_store.lock() {
                                v.extend(paths);
                            }
                        }
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
        }
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
        assert!(validate_session_entries(&mut session, Some(path)).is_err());
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
        )
        .expect_err("deleted file must conflict before overwrite confirmation");
        assert!(error.starts_with("ZITEXT_FILE_CONFLICT:"));
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
        let expected_folder = clean_path(folder);
        assert_eq!(parsed.folder.as_deref(), Some(expected_folder.as_str()));
        assert_eq!(parsed.files, vec![clean_path(file)]);
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

        signal_tab_closed(document_path).unwrap();
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
}
