use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use tauri::{Manager, Emitter};

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
static STARTUP_ARGS: OnceLock<std::sync::Mutex<Vec<String>>> = OnceLock::new();
static STARTUP_FOLDER: OnceLock<Option<String>> = OnceLock::new();
/// Tracks whether the frontend has already consumed startup args.
static STARTUP_ARGS_CONSUMED: OnceLock<std::sync::atomic::AtomicBool> = OnceLock::new();
/// Maps file path → lock file path for --wait mode.
/// When the tab is closed, the lock file is deleted.
static WAIT_LOCKS: OnceLock<std::sync::Mutex<HashMap<String, String>>> = OnceLock::new();

/// Session-restore decision signal. Set by the renderer-driven confirm
/// command once the user clicks Restore (true) or Skip (false) in the React
/// modal, or set immediately if there is no session to restore.
/// `get_last_session` waits on this before returning, so the renderer's
/// session-restore code does not race the prompt.
/// State: 0 = pending, 1 = restore, 2 = skip.
static SESSION_DECISION: OnceLock<std::sync::atomic::AtomicI8> = OnceLock::new();
static SESSION_DECISION_NOTIFY: OnceLock<tokio::sync::Notify> = OnceLock::new();

/// File-backed paths from the last session — populated by the startup task
/// and consumed by `confirm_session_restore` once the user clicks Restore.
/// Cached here so the renderer doesn't have to ship the paths back to grant.
static SESSION_RESTORE_PATHS: OnceLock<std::sync::Mutex<Vec<String>>> = OnceLock::new();

fn session_decision_atomic() -> &'static std::sync::atomic::AtomicI8 {
    SESSION_DECISION.get_or_init(|| std::sync::atomic::AtomicI8::new(0))
}
fn session_decision_notify() -> &'static tokio::sync::Notify {
    SESSION_DECISION_NOTIFY.get_or_init(tokio::sync::Notify::new)
}

fn set_session_decision(restore: bool) {
    session_decision_atomic().store(
        if restore { 1 } else { 2 },
        std::sync::atomic::Ordering::SeqCst,
    );
    session_decision_notify().notify_waiters();
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
const LARGE_FILE_WARNING: u64 = 1 * 1024 * 1024; // 1MB - warn user
const MAX_DIRECTORY_DEPTH: usize = 10;
const MAX_DIRECTORY_ENTRIES: usize = 5000;
const MAX_SEARCH_FILES_VISITED: u32 = 50_000;
const MAX_SEARCH_DURATION: std::time::Duration = std::time::Duration::from_secs(30);

/// Per-search budget: a worst-case query on a deep tree could otherwise read
/// tens of thousands of files. We cap files visited and total wall-clock time.
struct SearchBudget {
    files_visited: u32,
    started_at: std::time::Instant,
    /// Set true when any limit fires so the caller can surface partial results.
    stopped: bool,
}

impl SearchBudget {
    fn new() -> Self {
        Self {
            files_visited: 0,
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
fn strip_unc_prefix(p: PathBuf) -> PathBuf { p }

fn grants() -> &'static std::sync::Mutex<Vec<PathGrant>> {
    FILE_GRANTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Issues a single-file grant for the given path. Idempotent.
fn grant_file(path: &std::path::Path) {
    let Some(canonical) = canonical_form(path) else { return; };
    if let Ok(mut g) = grants().lock() {
        if !g.iter().any(|x| !x.recursive && x.canonical == canonical) {
            g.push(PathGrant { canonical, recursive: false });
        }
    }
}

/// Issues a recursive folder grant. The folder itself and any descendants
/// (after canonicalization) become accessible.
fn grant_folder(path: &std::path::Path) {
    let Some(canonical) = canonical_form(path) else { return; };
    if let Ok(mut g) = grants().lock() {
        if !g.iter().any(|x| x.recursive && x.canonical == canonical) {
            g.push(PathGrant { canonical, recursive: true });
        }
    }
}

/// Returns true if any active grant covers this path.
fn is_authorized(path: &std::path::Path) -> bool {
    let Some(canonical) = canonical_form(path) else { return false; };
    let Ok(g) = grants().lock() else { return false; };
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
    let Some(canonical) = canonical_form(path) else { return; };
    if let Ok(mut g) = grants().lock() {
        g.retain(|x| !(!x.recursive && x.canonical == canonical));
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
        path_buf.canonicalize().map_err(|e| format!("Invalid file path: {}", e))?
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
                && (path_str.len() == prefix.len()
                    || path_str[prefix.len()..].starts_with('/'))
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
        if path_str.starts_with(r"\\?\") {
            return path_str[4..].to_string();
        }
    }
    path_str
}

/// Validates file size before reading to prevent memory exhaustion
fn validate_file_size(path: &PathBuf) -> Result<u64, String> {
    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;
    
    let size = metadata.len();
    
    if size > MAX_FILE_SIZE {
        return Err(format!(
            "File too large ({:.1} MB). Maximum supported size is {} MB",
            size as f64 / 1_048_576.0,
            MAX_FILE_SIZE / 1_048_576
        ));
    }
    
    Ok(size)
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

fn default_autosave_delay() -> u32 { 2000 }
fn default_editor_theme() -> String { "vs-dark".to_string() }
fn default_sidebar_width() -> u32 { 250 }
fn default_enable_column_selection() -> bool { false }
fn default_tab_size() -> u32 { 4 }
fn default_insert_spaces() -> bool { true }
fn default_check_for_updates() -> bool { true }

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

    app.dialog()
        .file()
        .pick_file(move |file_path| {
            let _ = tx.blocking_send(file_path.map(|p| p.to_string()));
        });

    match tokio::time::timeout(
        tokio::time::Duration::from_secs(300),
        rx.recv()
    ).await {
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
async fn show_save_file_dialog(app: &tauri::AppHandle, default_name: String) -> Result<Option<String>, String> {
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

    match tokio::time::timeout(
        tokio::time::Duration::from_secs(300),
        rx.recv()
    ).await {
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
}

#[tauri::command]
async fn read_file_content(path: String) -> Result<FileReadResult, String> {
    dlog!("Request to read file: {}", path);

    // Reads require a live grant. Recent-files / session-restore reopens get
    // grants from the session-restore prompt at launch and from Recent-Files
    // menu clicks — never from the renderer auto-claiming a path is "recent".
    let validated_path = match authorize_path(&path) {
        Ok(p) => {
            dlog!("Path authorized: {:?}", p);
            p
        },
        Err(e) => {
            dlog!("Path authorization failed: {}", e);
            return Err(e);
        }
    };
    
    // Check if file exists
    if !validated_path.exists() {
        let err = format!("File does not exist: {:?}", validated_path);
        dlog!("{}", err);
        return Err(err);
    }
    
    // Check file size before reading
    let size = match validate_file_size(&validated_path) {
        Ok(s) => {
            dlog!("File size validated: {} bytes", s);
            s
        },
        Err(e) => {
            dlog!("File size validation failed: {}", e);
            return Err(e);
        }
    };
    
    let bytes = fs::read(&validated_path)
        .map_err(|e| {
            let err = format!("Failed to read file: {}", e);
            dlog!("{}", err);
            err
        })?;
    
    dlog!("File read successfully, {} bytes", bytes.len());

    // Binary detection: check the first 8 KB for null bytes.
    // Text files (even in non-UTF-8 encodings) virtually never contain 0x00.
    let check_len = bytes.len().min(8192);
    if bytes[..check_len].contains(&0u8) {
        return Err("This file appears to be binary. ZITEXT is a text editor and cannot display binary content.".to_string());
    }

    // Detect encoding and convert to UTF-8
    let (decoded, _, had_errors) = encoding_rs::UTF_8.decode(&bytes);
    
    if had_errors {
        dlog!("UTF-8 decoding had errors, trying WINDOWS_1252");
        let (decoded, _, _) = encoding_rs::WINDOWS_1252.decode(&bytes);
        Ok(FileReadResult {
            content: decoded.into_owned(),
            size,
            encoding: "Windows-1252".to_string(),
        })
    } else {
        dlog!("File decoded successfully as UTF-8");
        Ok(FileReadResult {
            content: decoded.into_owned(),
            size,
            encoding: "UTF-8".to_string(),
        })
    }
}

#[tauri::command]
async fn write_file_content(path: String, content: String) -> Result<(), String> {
    dlog!("Request to write file: {}", path);
    // Writes require a live grant — never a recent-files fallback. A path the
    // user opened in a prior session can be re-read, but writing always needs
    // an explicit current-session dialog or already-open tab.
    let validated_path = match authorize_path(&path) {
        Ok(p) => {
            dlog!("Path authorized: {:?}", p);
            p
        },
        Err(e) => {
            dlog!("Path authorization failed: {}", e);
            return Err(e);
        }
    };

    fs::write(&validated_path, content.as_bytes())
        .map_err(|e| {
            dlog!("File write error: {}", e);
            format!("Failed to write file: {}", e)
        })
}

/// Full settings read for INTERNAL use only (not a command). Includes
/// `last_session`, which holds previous-session file paths and preserved unsaved
/// buffer content — that data must not reach the renderer before restore consent.
async fn load_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let config_path = get_config_path(app)?;

    if !config_path.exists() {
        return Ok(AppSettings::default());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read settings: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse settings: {}", e))
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
async fn write_settings_to_disk(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    use std::io::Write;
    let config_path = get_config_path(app)?;

    // Create parent directory if it doesn't exist
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    // Atomic write: write a sibling temp file, fsync, then rename over the
    // target. A crash mid-write can't truncate/corrupt the live settings file
    // (which also holds the crash-recovery session snapshot).
    let tmp_path = config_path.with_file_name("settings.json.tmp");
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temp settings file: {}", e))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write temp settings file: {}", e))?;
        f.sync_all()
            .map_err(|e| format!("Failed to flush temp settings file: {}", e))?;
    }
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("Failed to replace settings file: {}", e))
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
    // last_session and active_tab_path are backend-owned (written by
    // save_session) and are not authoritative in the renderer. Preserve the
    // on-disk values so an ordinary settings write (theme/font/etc.) can't
    // clobber the saved session or the active-tab pointer.
    settings.last_session = current.last_session;
    settings.active_tab_path = current.active_tab_path;
    write_settings_to_disk(app, settings).await
}

#[tauri::command]
async fn get_recent_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let settings = load_settings(app).await?;
    Ok(settings.recent_files)
}

#[tauri::command]
async fn add_recent_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // Validate path before persisting — prevents storing traversal paths or
    // virtual filesystem paths in the recent-files list.
    let validated = validate_path(&path)?;
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

#[tauri::command]
async fn save_session(app: tauri::AppHandle, session: Vec<SessionFile>, active_tab_path: Option<String>) -> Result<(), String> {
    let _guard = settings_lock().lock().await;
    let mut settings = load_settings(app.clone()).await?;
    settings.last_session = session;
    settings.active_tab_path = active_tab_path;
    write_settings_to_disk(app, settings).await
}

/// Renderer-driven session-restore confirmation. The startup task emits a
/// `session-restore-prompt` event after stashing file paths in
/// `SESSION_RESTORE_PATHS`; the React modal collects the user's choice and
/// calls this command. On Restore (true), all stashed paths are granted so
/// the renderer's subsequent read_file_content calls succeed. On Skip
/// (false), no grants are issued.
#[tauri::command]
fn confirm_session_restore(restore: bool) -> Result<(), String> {
    if restore {
        if let Some(store) = SESSION_RESTORE_PATHS.get() {
            if let Ok(paths) = store.lock() {
                for path in paths.iter() {
                    grant_file(std::path::Path::new(path));
                }
            }
        }
    }
    set_session_decision(restore);
    Ok(())
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
    let restore = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_session_decision(),
    )
    .await
    .unwrap_or(false);

    if restore {
        Ok(settings.last_session)
    } else {
        Ok(settings
            .last_session
            .into_iter()
            .filter(|s| s.is_untitled)
            .collect())
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
    let files = args.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default();
    Ok(files)
}

#[tauri::command]
async fn get_startup_folder() -> Result<Option<String>, String> {
    Ok(STARTUP_FOLDER.get().cloned().unwrap_or(None))
}

/// Signals that a tab with the given path was closed.
/// If a --wait lock file exists for this path, it is deleted so the CLI unblocks.
#[tauri::command]
async fn signal_tab_closed(path: String) -> Result<(), String> {
    let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    if let Ok(mut map) = locks.lock() {
        if let Some(lock_path) = map.remove(&path) {
            // Only delete files inside the system temp directory (defense-in-depth)
            let lock = PathBuf::from(&lock_path);
            if lock.starts_with(std::env::temp_dir()) {
                let _ = fs::remove_file(&lock_path);
            }
        }
    }
    Ok(())
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

    app.dialog()
        .file()
        .pick_folder(move |folder_path| {
            let _ = tx.send(folder_path.map(|p| p.to_string()));
        });

    match tokio::time::timeout(
        tokio::time::Duration::from_secs(300),
        rx
    ).await {
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
    use std::time::SystemTime;

    // Listing requires a grant covering the directory (usually a folder grant
    // from open_folder_dialog or CLI args).
    let validated_path = authorize_path(&path)?;
    
    fn read_dir_recursive(
        path: &std::path::Path, 
        recursive: bool,
        depth: usize,
        entry_count: &mut usize
    ) -> Result<Vec<FileEntry>, String> {
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
        
        let dir_entries = fs::read_dir(path)
            .map_err(|e| format!("Failed to read directory: {}", e))?;
        
        for entry in dir_entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();

            // Skip symlinks — prevents escaping the intended directory tree via
            // crafted or malicious symlinks.
            if let Ok(sym_meta) = fs::symlink_metadata(&path) {
                if sym_meta.file_type().is_symlink() {
                    continue;
                }
            }

            let metadata = entry.metadata().ok();

            let name = path.file_name()
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
                metadata.as_ref()
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
            let size = metadata.as_ref().and_then(|m| if !is_directory { Some(m.len()) } else { None });
            let modified = metadata.as_ref().and_then(|m| {
                m.modified().ok().and_then(|t| {
                    t.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
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
                match read_dir_recursive(&path, true, depth + 1, entry_count) {
                    Ok(mut sub_entries) => entries.append(&mut sub_entries),
                    Err(_) => {} // Skip directories we can't read
                }
            }
        }
        
        Ok(entries)
    }
    
    let mut entry_count = 0;
    read_dir_recursive(&validated_path, recursive, 0, &mut entry_count)
}

#[derive(Debug, Serialize, Deserialize)]
struct FileMetadata {
    modified: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileMetadataWithPath {
    path: String,
    modified: u64,
}

#[tauri::command]
async fn get_file_metadata(path: String) -> Result<FileMetadata, String> {
    use std::time::SystemTime;

    let validated_path = authorize_path(&path)?;
    
    let metadata = fs::metadata(&validated_path)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;
    
    let modified = metadata.modified()
        .map_err(|e| format!("Failed to get modification time: {}", e))?
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| format!("Failed to convert time: {}", e))?
        .as_secs();
    
    Ok(FileMetadata { modified })
}

#[tauri::command]
async fn get_files_metadata(paths: Vec<String>) -> Result<Vec<FileMetadataWithPath>, String> {
    use std::time::SystemTime;
    
    let mut results = Vec::new();
    
    for path in paths {
        // Skip unauthorized paths silently — file watchers commonly poll
        // currently-open files, and unauthorized entries here just shouldn't
        // surface metadata. Failing the whole batch would hide legit changes.
        let validated_path = match authorize_path(&path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        
        // Use symlink_metadata so we read the symlink's own mod time rather than
        // silently following it to a potentially arbitrary target.
        if let Ok(metadata) = fs::symlink_metadata(&validated_path) {
            if let Ok(modified_time) = metadata.modified() {
                if let Ok(duration) = modified_time.duration_since(SystemTime::UNIX_EPOCH) {
                    results.push(FileMetadataWithPath {
                        path,
                        modified: duration.as_secs(),
                    });
                }
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
    // Both endpoints must be authorized. Typical rename happens inside an
    // open folder, so a single recursive folder grant covers both. For a
    // cross-folder rename, the user would have needed grants on both sides.
    let validated_old = authorize_path(&old_path)?;
    let validated_new = authorize_path(&new_path)?;
    fs::rename(&validated_old, &validated_new).map_err(|e| e.to_string())?;
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
    recent_files: Vec<String>
) -> Result<tauri::menu::Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};

    // Standard App Menu
    let app_menu = Submenu::with_id(handle, "app", "ZITEXT", true)?;

    // File Menu
    let file_menu = Submenu::with_id(handle, "file", "File", true)?;
    let m_new = MenuItem::with_id(handle, "new", "New", true, Some("CmdOrCtrl+N"))?;
    let m_open = MenuItem::with_id(handle, "open", "Open File...", true, Some("CmdOrCtrl+O"))?;
    let m_open_folder = MenuItem::with_id(handle, "open_folder", "Open Folder...", true, None::<&str>)?;

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
            let m_recent = MenuItem::with_id(
                handle,
                &menu_id,
                file_name,
                true,
                None::<&str>
            )?;
            recent_menu.append(&m_recent)?;
        }

        file_menu.append(&recent_menu)?;
        file_menu.append(&PredefinedMenuItem::separator(handle)?)?;
    }

    let m_save = MenuItem::with_id(handle, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let m_save_as = MenuItem::with_id(handle, "save_as", "Save As...", true, Some("CmdOrCtrl+Shift+S"))?;
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
    let m_replace = MenuItem::with_id(handle, "replace", "Find & Replace...", true, Some("CmdOrCtrl+H"))?;
    let m_find_in_files = MenuItem::with_id(handle, "find_in_files", "Find in Files...", true, Some("CmdOrCtrl+Shift+F"))?;
    let m_goto = MenuItem::with_id(handle, "goto", "Go to Line...", true, Some("CmdOrCtrl+G"))?;
    edit_menu.append(&m_find)?;
    edit_menu.append(&m_replace)?;
    edit_menu.append(&m_find_in_files)?;
    edit_menu.append(&m_goto)?;

    // View Menu
    let view_menu = Submenu::with_id(handle, "view", "View", true)?;
    let m_theme = MenuItem::with_id(handle, "toggle_theme", "Toggle Theme (Dark/Light)", true, None::<&str>)?;
    let m_wrap = MenuItem::with_id(handle, "toggle_wrap", "Toggle Word Wrap", true, None::<&str>)?;
    let m_explorer = MenuItem::with_id(handle, "toggle_explorer", "Toggle Explorer", true, None::<&str>)?;
    let m_preview = MenuItem::with_id(handle, "toggle_preview", "Toggle Markdown Preview", true, Some("CmdOrCtrl+Shift+V"))?;
    let m_copy_path = MenuItem::with_id(handle, "copy_path", "Copy File Path", true, None::<&str>)?;
    let m_split = MenuItem::with_id(handle, "toggle_split", "Toggle Split View", true, Some("CmdOrCtrl+\\"))?;
    let m_open_right = MenuItem::with_id(handle, "open_right_pane", "Open in Right Pane", true, None::<&str>)?;
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
    let m_prefs = MenuItem::with_id(handle, "preferences", "Preferences...", true, Some("CmdOrCtrl+,"))?;
    let m_keys = MenuItem::with_id(handle, "shortcuts", "Keyboard Shortcuts...", true, None::<&str>)?;
    settings_menu.append(&m_prefs)?;
    settings_menu.append(&m_keys)?;

    // Help Menu
    let help_menu = Submenu::with_id(handle, "help", "Help", true)?;
    let m_about = MenuItem::with_id(handle, "about", "About ZITEXT Editor", true, None::<&str>)?;
    help_menu.append(&m_about)?;

    let menu = Menu::with_items(handle, &[
        &app_menu,
        &file_menu,
        &edit_menu,
        &view_menu,
        &lang_menu,
        &settings_menu,
        &help_menu,
    ])?;

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

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "rs", "ts", "tsx", "js", "jsx", "py", "java", "c", "cpp", "h", "hpp",
    "cs", "go", "rb", "php", "swift", "kt", "scala", "r", "lua", "perl", "sh", "bash",
    "zsh", "fish", "ps1", "bat", "cmd", "html", "css", "scss", "sass", "less",
    "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
    "sql", "graphql", "gql", "dockerfile", "makefile", "cmake", "mk",
    "gitignore", "lock", "log", "csv", "tsv", "tex", "rst", "adoc",
    "vue", "svelte", "astro", "mdx",
];

fn is_text_file(path: &std::path::Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if ext.is_empty() {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        return matches!(
            name.as_str(),
            "makefile" | "dockerfile" | "readme" | "license" | "todo"
                | ".env" | ".gitignore" | ".gitattributes" | ".editorconfig"
        );
    }

    TEXT_EXTENSIONS.contains(&ext.as_str())
}

fn search_file(
    path: &std::path::Path,
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    results: &mut Vec<FileSearchMatch>,
    max_results: usize,
    budget: &mut SearchBudget,
) {
    if !budget.check() {
        return;
    }
    budget.files_visited += 1;

    // Use symlink_metadata so we never follow a symlink to an unintended location.
    // If the entry is a symlink we skip it; if it's too large we skip for performance.
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || meta.len() > LARGE_FILE_WARNING {
            return;
        }
    }

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };

    for (line_idx, line) in content.lines().enumerate() {
        if results.len() >= max_results {
            break;
        }

        let haystack = if case_sensitive { line.to_string() } else { line.to_lowercase() };

        let mut search_start = 0;
        while search_start < haystack.len() {
            if results.len() >= max_results {
                break;
            }

            match haystack[search_start..].find(needle.as_str()) {
                None => break,
                Some(rel) => {
                    let abs_start = search_start + rel;
                    let abs_end = abs_start + needle.len();

                    let ok = if whole_word {
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
                        let char_end   = haystack[..abs_end].chars().count();
                        // 2. Walk the original line to the same char positions and
                        //    accumulate UTF-16 code units (BMP chars = 1, others = 2).
                        let utf16_start = line.chars()
                            .take(char_start)
                            .fold(0u32, |n, c| n + c.len_utf16() as u32);
                        let utf16_end = line.chars()
                            .take(char_end)
                            .fold(0u32, |n, c| n + c.len_utf16() as u32);
                        results.push(FileSearchMatch {
                            file_path: clean_path(path.to_path_buf()),
                            line_number: (line_idx + 1) as u32,
                            line_content: line.to_string(),
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
    query: &str,
    case_sensitive: bool,
    whole_word: bool,
    results: &mut Vec<FileSearchMatch>,
    max_results: usize,
    depth: usize,
    budget: &mut SearchBudget,
) {
    if depth > MAX_DIRECTORY_DEPTH || results.len() >= max_results || !budget.check() {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if results.len() >= max_results || !budget.check() {
            break;
        }

        let path = entry.path();

        // Skip symlinks — prevents following crafted symlinks outside the search root.
        if let Ok(sym_meta) = fs::symlink_metadata(&path) {
            if sym_meta.file_type().is_symlink() {
                continue;
            }
        }

        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        // Do not skip dotfiles — .bashrc, .gitignore, .env, etc. are valid search targets.
        // Specific large/binary dot-directories (.git, .venv, …) are excluded below.

        if path.is_dir() {
            // Skip well-known large or generated directories (build output, caches, VCS
            // data, etc.). These hold machine-generated files that would otherwise flood
            // results and exhaust the match cap / visit budget before real source files
            // are reached — e.g. a Next.js `.next` folder buried product-icons.tsx entirely.
            if matches!(
                name,
                "node_modules" | "target" | "dist" | "build" | ".git" | "__pycache__" | ".venv" | "vendor"
                    | ".next" | ".nuxt" | ".svelte-kit" | ".turbo" | ".angular" | ".vite"
                    | ".parcel-cache" | ".cache" | ".output" | "coverage"
            ) {
                continue;
            }
            search_dir_recursive(&path, query, case_sensitive, whole_word, results, max_results, depth + 1, budget);
        } else if is_text_file(&path) {
            search_file(&path, query, case_sensitive, whole_word, results, max_results, budget);
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
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let validated_folder = authorize_path(&folder)?;
    if !validated_folder.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    let mut results = Vec::new();
    let mut budget = SearchBudget::new();
    search_dir_recursive(&validated_folder, &query, case_sensitive, whole_word, &mut results, 500, 0, &mut budget);

    Ok(results)
}

/// Appends a line to the local crash.log file for diagnostics.
/// The log file is capped at 1 MB — older entries are discarded.
#[tauri::command]
async fn append_crash_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let log_dir = app.path()
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
    window.set_theme(t).map_err(|e| format!("set_theme failed: {e}"))
}

/// Opens a zitext.com URL in the system's default browser.
/// Restricted to https://zitext.com/* to prevent arbitrary URL opening.
/// Uses tauri-plugin-opener (ShellExecuteW on Windows, LSOpenCFURLRef on macOS,
/// xdg-open on Linux) — does NOT shell out to cmd.exe, so URL metacharacters
/// like &, |, ^ in path/query cannot break out into shell interpretation.
#[tauri::command]
fn open_url_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = url::Url::parse(&url)
        .map_err(|_| "Invalid URL".to_string())?;
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
fn close_confirmed() -> &'static std::sync::atomic::AtomicBool {
    CLOSE_CONFIRMED.get_or_init(|| std::sync::atomic::AtomicBool::new(false))
}

/// Called by the renderer once the user has dealt with unsaved changes. Marks
/// the close as confirmed and closes the window, which then exits the app.
#[tauri::command]
async fn confirm_app_close(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
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
    window.close().map_err(|e| format!("Failed to close window: {e}"))
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
    // session-restore prompt (confirm_session_restore), so a compromised renderer
    // can't widen its reach to the whole previous session by calling this.
    let known = settings.recent_files.iter().any(|p| p == &path);
    if known {
        grant_file(std::path::Path::new(&path));
        Ok(())
    } else {
        Err("Path is not in the recent-files list".to_string())
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
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                use std::io::Write;
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(f, r#"{{"ts":"{}","level":"panic","source":"rust","message":{}}}"#,
                    ts, serde_json::to_string(&message).unwrap_or_default());
            }
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            dlog!("Secondary instance launched with args: {:?}", args);
            // Skip the first argument which is the executable path
            if args.len() > 1 {
                for arg in args.iter().skip(1) {
                    if !arg.starts_with('-') {
                        // User opened a file via "zitext <file>" while the
                        // app was already running — grant before forwarding.
                        let pb = std::path::PathBuf::from(arg);
                        if pb.is_dir() {
                            grant_folder(&pb);
                        } else {
                            grant_file(&pb);
                        }
                        let _ = app.emit("open-file", arg);
                    }
                }
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
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            if !close_confirmed().load(std::sync::atomic::Ordering::SeqCst) {
                                api.prevent_close();
                                let _ = event_win.emit("close-requested", ());
                            }
                        }
                        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                            for p in paths {
                                if p.is_dir() {
                                    grant_folder(p);
                                    let _ = event_win.emit("open-folder", p.to_string_lossy().to_string());
                                } else if p.is_file() {
                                    grant_file(p);
                                    let _ = event_win.emit("open-file", p.to_string_lossy().to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                });
            }

            // Session-restore prompt: if a previous session has file-backed
            // tabs, stash the file list and ask the renderer to display its
            // own modal. The renderer answers via the `confirm_session_restore`
            // command, which is the only thing that grants paths and signals
            // the decision. `get_last_session` blocks on that decision so the
            // renderer's restore code does not race the prompt.
            let handle_for_restore = app.handle().clone();
            tauri::async_runtime::spawn(async move {
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

                // Stash the paths so `confirm_session_restore` can grant them
                // when the user clicks Restore in the modal.
                let store = SESSION_RESTORE_PATHS
                    .get_or_init(|| std::sync::Mutex::new(Vec::new()));
                if let Ok(mut v) = store.lock() {
                    *v = file_paths.clone();
                }

                // Give the window a moment to mount + listeners to attach.
                tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;

                let _ = handle_for_restore.emit(
                    "session-restore-prompt",
                    serde_json::json!({ "fileCount": file_paths.len() }),
                );

                // Do NOT call set_session_decision here — that happens in
                // `confirm_session_restore` after the user clicks.
            });

            // Handle initial command line arguments.
            // Resolves relative paths against cwd and separates files from folders.
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            let mut startup_files = Vec::new();
            let mut startup_folder: Option<String> = None;
            let wait_mode = args.iter().any(|a| a == "--wait" || a == "-w");

            if args.len() > 1 {
                for arg in args.iter().skip(1) {
                    if arg.starts_with('-') { continue; }
                    let resolved = if std::path::Path::new(arg).is_absolute() {
                        PathBuf::from(arg)
                    } else {
                        cwd.join(arg)
                    };
                    if !resolved.exists() { continue; }
                    // CLI args are user-initiated, so grant authority here
                    // before emitting to the renderer.
                    if resolved.is_dir() {
                        grant_folder(&resolved);
                        startup_folder = Some(clean_path(resolved));
                    } else {
                        grant_file(&resolved);
                        startup_files.push(clean_path(resolved));
                    }
                }
            }
            {
                let args_store = STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
                if let Ok(mut v) = args_store.lock() {
                    v.extend(startup_files.clone());
                }
            }
            let _ = STARTUP_FOLDER.set(startup_folder.clone());

            // --wait mode: create lock files that the CLI process polls.
            // When the tab is closed, signal_tab_closed removes the lock file.
            //
            // Security: filenames include a random nonce so an attacker cannot
            // pre-create a symlink at the predictable old path (e.g.
            // zitext-wait-_etc_passwd.lock → /etc/passwd) and have us clobber
            // it. We also use create_new + O_NOFOLLOW so an existing entry at
            // the chosen path causes failure rather than a symlink follow.
            if wait_mode && !startup_files.is_empty() {
                use rand::RngCore;
                let locks = WAIT_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
                if let Ok(mut map) = locks.lock() {
                    for file_path in &startup_files {
                        let nonce = rand::thread_rng().next_u64();
                        let sanitized = file_path.replace(['/', '\\', ':'], "_");
                        let lock_path = std::env::temp_dir()
                            .join(format!("zitext-wait-{}-{:016x}.lock", sanitized, nonce));

                        let mut opts = fs::OpenOptions::new();
                        opts.write(true).create_new(true);
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::OpenOptionsExt;
                            // O_NOFOLLOW: refuse to open if the final path component
                            // is a symlink. Combined with create_new (O_EXCL), this
                            // closes the symlink-replacement race on Unix.
                            opts.custom_flags(libc::O_NOFOLLOW);
                        }
                        if opts.open(&lock_path).is_ok() {
                            map.insert(file_path.clone(), lock_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

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
            save_session,
            get_last_session,
            confirm_session_restore,
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
                        if let Some(w) = app_handle.get_webview_window("main")
                            .or_else(|| app_handle.webview_windows().values().next().cloned())
                        {
                            let _ = w.emit("close-requested", ());
                        }
                    }
                }
                // Handle files opened via macOS Finder ("Open With" / file
                // associations). RunEvent::Opened only exists on macOS.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let handle = app_handle.clone();
                    let paths: Vec<String> = urls.iter()
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
                            let args_store = STARTUP_ARGS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
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
