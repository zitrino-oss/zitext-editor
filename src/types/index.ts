export interface Tab {
  id: string;
  path: string | null; // null for untitled files
  content: string;
  /** Monotonic content version used to make asynchronous saves race-safe. */
  revision: number;
  cursorLine: number;
  cursorColumn: number;
  isDirty: boolean;
  language: string;
  /** Changes whenever the editor should scroll the cursor into view (search
   *  result, Go to Line), even when the line itself did not change. */
  revealRequest?: number;
  /** The user picked the language; content detection leaves it alone. */
  languageLocked?: boolean;
  isReadOnly: boolean;
  encoding: string;
  /** Last disk snapshot used for optimistic overwrite protection. */
  diskVersion: DiskVersion | null;
  /** Mixed until the document is edited (the editor then keeps one style). */
  eol: 'LF' | 'CRLF' | 'Mixed';
  // Scroll position, title, and tab state
  scrollTop: number;
  scrollLeft: number;
  title: string;
  isUntitled: boolean;
  externallyModified: boolean;
  externalChangeCount: number; // incremented each change — lets prompt reappear on repeated modifications
  isPreview?: boolean;
  isPinned?: boolean;
}

export interface DiskVersion {
  modified: number;
  size: number;
  hash: string;
}

export interface Settings {
  // Appearance, recent files, and last session
  theme: 'light' | 'dark' | 'system';
  /** Editor code font. */
  fontFamily: string;
  /** App chrome typeface — distinct from the editor font above. */
  uiFont: string;
  fontSize: number;
  wordWrap: boolean;
  recentFiles: string[];
  lastSession: SessionFile[];

  // Autosave, layout, and editor behavior
  autosave: 'off' | 'afterDelay' | 'onFocusChange';
  autosaveDelay: number; // milliseconds
  showMinimap: boolean;
  editorTheme: string;
  keybindings: Record<string, string>;
  openedFolder: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  activeTabPath: string | null;
  enableColumnSelection: boolean;

  // Indentation and formatting
  tabSize: number;
  insertSpaces: boolean;
  formatOnSave: boolean;

  // Updates
  checkForUpdates: boolean;
}

export interface SessionFile {
  path: string;
  cursor_line: number;
  cursor_column: number;
  scroll_top?: number;
  scroll_left?: number;
  is_untitled?: boolean;
  // Set on a saved (disk-backed) file that had unsaved edits when the snapshot
  // was taken, so crash recovery can re-apply those edits. `content` then holds
  // the unsaved buffer rather than being absent.
  is_dirty?: boolean;
  // Marks the tab that was active, so restore can reselect it without
  // active_tab_path being exposed via the (redacted) read_settings.
  is_active?: boolean;
  content?: string;
  // For a dirty saved file: the on-disk version its unsaved edits were based
  // on. Restore treats a different current version as a conflict instead of
  // silently making the recovered buffer overwrite it.
  base_version?: DiskVersion;
}

export interface EditorState {
  tabs: Tab[];
  activeTabId: string | null;
  settings: Settings;
}

export interface FindState {
  isOpen: boolean;
  searchText: string;
  caseSensitive: boolean;
}

export interface GoToLineState {
  isOpen: boolean;
  lineNumber: string;
}

export interface SettingsModalState {
  isOpen: boolean;
}

// File explorer, keybinding, and find/replace types

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
  children?: FileNode[];
  expanded?: boolean;
  /** An informational row (e.g. "only the first 5,000 items are shown"). */
  placeholder?: boolean;
}

export interface KeybindingConfig {
  command: string;
  key: string;
  label: string;
  defaultKey: string;
}

export interface FindReplaceState {
  isOpen: boolean;
  searchText: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}
