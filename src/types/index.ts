export interface Tab {
  id: string;
  path: string | null; // null for untitled files
  content: string;
  cursorLine: number;
  cursorColumn: number;
  isDirty: boolean;
  language: string;
  isReadOnly: boolean;
  encoding: string;
  eol: 'LF' | 'CRLF';
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

export interface Settings {
  // Appearance, recent files, and last session
  theme: 'light' | 'dark';
  fontFamily: string;
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
  sortJsonKeys: boolean;
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

