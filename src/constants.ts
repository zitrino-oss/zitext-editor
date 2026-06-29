/**
 * Application Constants
 * 
 * Centralized constants to avoid magic numbers and improve maintainability.
 */

// ============================================================================
// Editor Configuration
// ============================================================================

/** Minimum font size allowed in the editor */
export const MIN_FONT_SIZE = 8;

/** Maximum font size allowed in the editor */
export const MAX_FONT_SIZE = 72;

/** Default font size for the editor */
export const DEFAULT_FONT_SIZE = 14;

/** Font size increment/decrement step */
export const FONT_SIZE_STEP = 1;

/** Delay before restoring active tab after session load (ms) */
export const SESSION_RESTORE_DELAY_MS = 100;

/** Minimum content length to trigger auto-language detection */
export const AUTO_LANGUAGE_DETECTION_THRESHOLD = 20;

// ============================================================================
// File Watcher Configuration
// ============================================================================

/** Interval for polling file changes (ms) */
export const FILE_WATCH_POLL_INTERVAL_MS = 2000;

// ============================================================================
// File Size Thresholds
// ============================================================================

/** Large file warning threshold (bytes) - 1MB */
export const LARGE_FILE_WARNING_BYTES = 1 * 1024 * 1024;

/** Bytes per megabyte conversion factor */
export const BYTES_PER_MB = 1024 * 1024;

// ============================================================================
// Sidebar Configuration
// ============================================================================

/** Minimum width for the file explorer sidebar (px) */
export const SIDEBAR_MIN_WIDTH = 150;

/** Maximum width for the file explorer sidebar (px) */
export const SIDEBAR_MAX_WIDTH = 600;

/** Default width for the file explorer sidebar (px) */
export const SIDEBAR_DEFAULT_WIDTH = 250;

// ============================================================================
// Dialog Timeouts
// ============================================================================

/** Timeout for file/folder dialog operations (ms) */
export const DIALOG_TIMEOUT_MS = 300000; // 5 minutes

// ============================================================================
// Recent Files
// ============================================================================

/** Maximum number of recent files to keep */
export const MAX_RECENT_FILES = 10;

// ============================================================================
// Toast Notifications
// ============================================================================

/** Default duration for error toasts (ms) */
export const TOAST_ERROR_DURATION_MS = 5000;

/** Default duration for warning toasts (ms) */
export const TOAST_WARNING_DURATION_MS = 4000;

/** Default duration for success toasts (ms) */
export const TOAST_SUCCESS_DURATION_MS = 3000;

/** Default duration for info toasts (ms) */
export const TOAST_INFO_DURATION_MS = 3000;

// ============================================================================
// Security Limits (Backend)
// ============================================================================

/** Maximum file size that can be opened (bytes) - 10MB */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Maximum directory depth for recursive reads */
export const MAX_DIRECTORY_DEPTH = 10;

/** Maximum number of directory entries to read */
export const MAX_DIRECTORY_ENTRIES = 5000;
