import { useState } from 'react';
import { getShortcutDisplay, isMac } from '../utils/shortcuts';
import type { Settings } from '../types';

interface MenuBarProps {
    onNew: () => void;
    onOpen: () => void;
    onOpenFolder: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onClose: () => void;
    onRevertFile: () => void;
    onFind: () => void;
    onFindInFiles: () => void;
    onReplace: () => void;
    onGoToLine: () => void;
    onCommandPalette: () => void;
    onToggleTheme: () => void;
    onToggleWordWrap: () => void;
    onToggleReadOnly: () => void;
    onOpenSettings: () => void;
    onOpenKeybindings: () => void;
    onToggleExplorer: () => void;
    onToggleSplitView: () => void;
    onOpenInRightPane: () => void;
    onSwapPanes: () => void;
    onChangeLanguage: (language: string) => void;
    onCopyPath: () => void;
    recentFiles: string[];
    onOpenRecent: (path: string) => void;
    settings: Settings;
    hasActiveTab: boolean;
    isReadOnly: boolean;
    activeTabPath: string | null;
    splitViewEnabled: boolean;
    hasRightPane: boolean;
    hasSavedPath: boolean;
    onAbout: () => void;
}

export function MenuBar({
    onNew,
    onOpen,
    onOpenFolder,
    onSave,
    onSaveAs,
    onClose,
    onRevertFile,
    onFind,
    onFindInFiles,
    onReplace,
    onGoToLine,
    onCommandPalette,
    onToggleTheme,
    onToggleWordWrap,
    onToggleReadOnly,
    onOpenSettings,
    onOpenKeybindings,
    onToggleExplorer,
    onToggleSplitView,
    onOpenInRightPane,
    onSwapPanes,
    onChangeLanguage,
    onCopyPath,
    recentFiles,
    onOpenRecent,
    settings,
    hasActiveTab,
    isReadOnly,
    activeTabPath,
    splitViewEnabled,
    hasRightPane,
    hasSavedPath,
    onAbout,
}: MenuBarProps) {
    const [activeMenu, setActiveMenu] = useState<string | null>(null);

    const closeMenu = () => setActiveMenu(null);
    const handleMenuClick = (menu: string) => setActiveMenu(activeMenu === menu ? null : menu);

    return (
        <div className="menu-bar">
            {/* File Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('file')}>
                File
                {activeMenu === 'file' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className="menu-option" onClick={() => { onNew(); closeMenu(); }}>
                            New <span className="shortcut">{getShortcutDisplay('N')}</span>
                        </div>
                        <div className="menu-option" onClick={() => { onOpen(); closeMenu(); }}>
                            Open File... <span className="shortcut">{getShortcutDisplay('O')}</span>
                        </div>
                        <div className="menu-option" onClick={() => { onOpenFolder(); closeMenu(); }}>
                            Open Folder...
                        </div>
                        <div className="menu-divider" />
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onSave(); closeMenu(); } }}>
                            Save <span className="shortcut">{getShortcutDisplay('S')}</span>
                        </div>
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onSaveAs(); closeMenu(); } }}>
                            Save As... <span className="shortcut">{getShortcutDisplay('S', true, true)}</span>
                        </div>
                        <div className={`menu-option ${!hasSavedPath ? 'disabled' : ''}`} onClick={() => { if (hasSavedPath) { onRevertFile(); closeMenu(); } }}>
                            Revert File
                        </div>
                        <div className="menu-divider" />
                        {recentFiles.length > 0 && (
                            <>
                                <div className="menu-submenu">
                                    Recent Files
                                    <div className="menu-dropdown-nested">
                                        {recentFiles.map((file, index) => (
                                            <div key={index} className="menu-option" onClick={() => { onOpenRecent(file); closeMenu(); }}>
                                                {file.split(/[\\/]/).pop()}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div className="menu-divider" />
                            </>
                        )}
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onClose(); closeMenu(); } }}>
                            Close Tab <span className="shortcut">{getShortcutDisplay('W')}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* Edit Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('edit')}>
                Edit
                {activeMenu === 'edit' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onFind(); closeMenu(); } }}>
                            Find... <span className="shortcut">{getShortcutDisplay('F')}</span>
                        </div>
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onReplace(); closeMenu(); } }}>
                            Find &amp; Replace... <span className="shortcut">{getShortcutDisplay('H')}</span>
                        </div>
                        <div className="menu-option" onClick={() => { onFindInFiles(); closeMenu(); }}>
                            Find in Files... <span className="shortcut">{getShortcutDisplay('F', true, true)}</span>
                        </div>
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onGoToLine(); closeMenu(); } }}>
                            Go to Line... <span className="shortcut">{getShortcutDisplay('G')}</span>
                        </div>
                        <div className="menu-divider" />
                        <div className="menu-option disabled" title="Use modifier+/ in editor">
                            Toggle Line Comment <span className="shortcut">{getShortcutDisplay('/')}</span>
                        </div>
                        <div className="menu-option disabled" title="Use Shift+Alt+F in editor">
                            Format Document <span className="shortcut">{isMac ? '⇧⌥F' : 'Shift+Alt+F'}</span>
                        </div>
                    </div>
                )}
            </div>

            {/* View Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('view')}>
                View
                {activeMenu === 'view' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className="menu-option" onClick={() => { onCommandPalette(); closeMenu(); }}>
                            Command Palette... <span className="shortcut">{getShortcutDisplay('P', true, true)}</span>
                        </div>
                        <div className="menu-divider" />
                        <div className="menu-option" onClick={() => { onToggleTheme(); closeMenu(); }}>
                            Toggle Theme (Dark/Light)
                        </div>
                        <div className="menu-divider" />
                        <div className="menu-option" onClick={() => { onToggleWordWrap(); closeMenu(); }}>
                            {settings.wordWrap ? '✓ Word Wrap' : 'Word Wrap'}
                        </div>
                        <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onToggleReadOnly(); closeMenu(); } }}>
                            {isReadOnly ? '✓ Read-Only' : 'Read-Only'}
                        </div>
                        <div className="menu-divider" />
                        <div className="menu-option" onClick={() => { onToggleExplorer(); closeMenu(); }}>
                            Toggle Explorer
                        </div>
                        <div className="menu-option" onClick={() => { onToggleSplitView(); closeMenu(); }}>
                            {splitViewEnabled ? '✓ Split View' : 'Split View'} <span className="shortcut">{getShortcutDisplay('\\')}</span>
                        </div>
                        <div className={`menu-option ${!hasActiveTab || !splitViewEnabled ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab && splitViewEnabled) { onOpenInRightPane(); closeMenu(); } }}>
                            Open in Right Pane
                        </div>
                        <div className={`menu-option ${!hasRightPane ? 'disabled' : ''}`} onClick={() => { if (hasRightPane) { onSwapPanes(); closeMenu(); } }}>
                            Swap Panes
                        </div>
                        <div className="menu-divider" />
                        <div className={`menu-option ${!activeTabPath ? 'disabled' : ''}`} onClick={() => { if (activeTabPath) { onCopyPath(); closeMenu(); } }}>
                            Copy File Path
                        </div>
                    </div>
                )}
            </div>

            {/* Settings Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('settings')}>
                Settings
                {activeMenu === 'settings' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className="menu-option" onClick={() => { onOpenSettings(); closeMenu(); }}>
                            Preferences... <span className="shortcut">Ctrl+,</span>
                        </div>
                        <div className="menu-option" onClick={() => { onOpenKeybindings(); closeMenu(); }}>
                            Keyboard Shortcuts...
                        </div>
                    </div>
                )}
            </div>

            {/* Language Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('language')}>
                Language
                {activeMenu === 'language' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className="menu-submenu">
                            <span>Web and Markup</span>
                            <div className="menu-dropdown-nested">
                                {[['html','HTML'],['css','CSS'],['javascript','JavaScript'],['typescript','TypeScript'],['php','PHP'],['scss','SCSS'],['sass','Sass'],['less','Less'],['markdown','Markdown']].map(([id, label]) => (
                                    <div key={id} className="menu-option" onClick={() => { onChangeLanguage(id); closeMenu(); }}>{label}</div>
                                ))}
                            </div>
                        </div>
                        <div className="menu-submenu">
                            <span>General Programming</span>
                            <div className="menu-dropdown-nested">
                                {[['python','Python'],['java','Java'],['csharp','C#'],['go','Go'],['ruby','Ruby'],['swift','Swift'],['kotlin','Kotlin'],['dart','Dart'],['lua','Lua'],['perl','Perl'],['r','R'],['scala','Scala'],['haskell','Haskell'],['elixir','Elixir'],['clojure','Clojure']].map(([id, label]) => (
                                    <div key={id} className="menu-option" onClick={() => { onChangeLanguage(id); closeMenu(); }}>{label}</div>
                                ))}
                            </div>
                        </div>
                        <div className="menu-submenu">
                            <span>Systems and Engineering</span>
                            <div className="menu-dropdown-nested">
                                {[['c','C'],['cpp','C++'],['rust','Rust'],['objective-c','Objective-C'],['fortran','Fortran'],['pascal','Pascal'],['ocaml','OCaml'],['verilog','Verilog'],['vhdl','VHDL'],['solidity','Solidity']].map(([id, label]) => (
                                    <div key={id} className="menu-option" onClick={() => { onChangeLanguage(id); closeMenu(); }}>{label}</div>
                                ))}
                            </div>
                        </div>
                        <div className="menu-submenu">
                            <span>Data and Config</span>
                            <div className="menu-dropdown-nested">
                                {[['json','JSON'],['xml','XML'],['yaml','YAML'],['toml','TOML'],['ini','INI'],['sql','SQL'],['graphql','GraphQL'],['redis','Redis']].map(([id, label]) => (
                                    <div key={id} className="menu-option" onClick={() => { onChangeLanguage(id); closeMenu(); }}>{label}</div>
                                ))}
                            </div>
                        </div>
                        <div className="menu-submenu">
                            <span>Scripts and Build</span>
                            <div className="menu-dropdown-nested">
                                {[['shell','Shell'],['powershell','PowerShell'],['bat','Batch'],['dockerfile','Dockerfile'],['makefile','Makefile'],['latex','LaTeX'],['plaintext','Plain Text']].map(([id, label]) => (
                                    <div key={id} className="menu-option" onClick={() => { onChangeLanguage(id); closeMenu(); }}>{label}</div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
            {/* Help Menu */}
            <div className="menu-item" onClick={() => handleMenuClick('help')}>
                Help
                {activeMenu === 'help' && (
                    <div className="menu-dropdown" onMouseLeave={closeMenu}>
                        <div className="menu-option" onClick={() => { onAbout(); closeMenu(); }}>
                            About ZITEXT Editor
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
