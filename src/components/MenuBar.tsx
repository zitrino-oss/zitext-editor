import { useEffect, useRef, useState } from 'react';
import { getShortcutDisplay, isLinux, isWindows } from '../utils/shortcuts';
import { WindowControls } from './WindowControls';
import type { Settings } from '../types';
import { getDirectEnabledMenuItems, openKeyboardSubmenu } from './menuNavigation';
import { languageBadge } from '../utils/languageBadges';
import { LANGUAGE_GROUPS, LANGUAGES } from '../utils/languages';
import { TEXT_TOOLS, type TextToolId, type TextToolInfo } from '../utils/textToolList';

const TOOL_GROUPS: { group: TextToolInfo['group']; label: string }[] = [
    { group: 'Lines', label: 'Lines' },
    { group: 'Case', label: 'Case' },
    { group: 'Encode', label: 'Encode / Decode' },
    { group: 'Generate', label: 'Generate and Checksums' },
    { group: 'Convert', label: 'Convert' },
];

function LanguageOption({ id, label, current, onPick }: {
    id: string;
    label: string;
    current: string | null;
    onPick: (id: string) => void;
}) {
    const [badge, color] = languageBadge(id);
    const isActive = current === id;

    return (
        <div
            className={`menu-option lang-option${isActive ? ' active' : ''}`}
            /* Roles are assigned centrally by the effect below, so this marks
               the selection with aria-current rather than a radio role. */
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onPick(id)}
        >
            <span
                className="lang-badge"
                style={{ '--lang-color': color } as React.CSSProperties}
                aria-hidden="true"
            >{badge}</span>
            <span>{label}</span>
            {isActive && <span className="lang-dot" aria-hidden="true" />}
        </div>
    );
}

interface MenuBarProps {
    onNew: () => void;
    onOpen: () => void;
    onOpenFolder: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onClose: () => void;
    onOpenLargeFile: () => void;
    onCompareWithFile: () => void;
    onCompareWithClipboard: () => void;
    onCompareWithSaved: () => void;
    onCompareWithTab: () => void;
    onOpenScratchpad: () => void;
    onTextTool: (id: TextToolId) => void;
    onMarkSelection: () => void;
    onMarkFind: () => void;
    onMarkText: () => void;
    onMarkRegex: () => void;
    onNextMark: () => void;
    onPreviousMark: () => void;
    onClearMarks: () => void;
    onRevertFile: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onCut: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onSelectAll: () => void;
    onToggleLineComment: () => void;
    onFormatDocument: () => void;
    onFind: () => void;
    onFindInFiles: () => void;
    onReplace: () => void;
    onGoToLine: () => void;
    onCommandPalette: () => void;
    onToggleTheme: () => void;
    onToggleWordWrap: () => void;
    onToggleReadOnly: () => void;
    onTogglePreview: () => void;
    onOpenSettings: () => void;
    onOpenKeybindings: () => void;
    onToggleExplorer: () => void;
    onToggleSplitView: () => void;
    onOpenInRightPane: () => void;
    onSwapPanes: () => void;
    onChangeLanguage: (language: string) => void;
    currentLanguage: string | null;
    onCopyPath: () => void;
    onToggleFullScreen: () => void;
    isFullscreen: boolean;
    recentFiles: string[];
    onOpenRecent: (path: string) => void;
    settings: Settings;
    hasActiveTab: boolean;
    /** A Large File / Log, Compare or Scratchpad view on screen: Save, Close,
     *  Find and Go to Line go to it, and the edit commands to its editor. */
    shownViewKind?: 'log' | 'compare' | 'scratchpad' | null;
    /** The focused tab is Markdown, so it has a preview. */
    canPreview: boolean;
    isReadOnly: boolean;
    isPreview: boolean;
    activeTabPath: string | null;
    splitViewEnabled: boolean;
    hasRightPane: boolean;
    hasSavedPath: boolean;
    /* Shown centred in the bar where the app draws its own titlebar; elsewhere
       the OS titlebar already says this, so it is not rendered twice. */
    windowTitle: string;
    onAbout: () => void;
}

export function MenuBar({
    onNew,
    onOpen,
    onOpenFolder,
    onSave,
    onSaveAs,
    onClose,
    onOpenLargeFile,
    onCompareWithFile,
    onCompareWithClipboard,
    onCompareWithSaved,
    onCompareWithTab,
    onOpenScratchpad,
    onTextTool,
    onMarkSelection,
    onMarkFind,
    onMarkText,
    onMarkRegex,
    onNextMark,
    onPreviousMark,
    onClearMarks,
    onRevertFile,
    onUndo,
    onRedo,
    onCut,
    onCopy,
    onPaste,
    onSelectAll,
    onToggleLineComment,
    onFormatDocument,
    onFind,
    onFindInFiles,
    onReplace,
    onGoToLine,
    onCommandPalette,
    onToggleTheme,
    onToggleWordWrap,
    onToggleReadOnly,
    onTogglePreview,
    onOpenSettings,
    onOpenKeybindings,
    onToggleExplorer,
    onToggleSplitView,
    onOpenInRightPane,
    onSwapPanes,
    onChangeLanguage,
    onCopyPath,
    onToggleFullScreen,
    isFullscreen,
    recentFiles,
    onOpenRecent,
    settings,
    hasActiveTab,
    shownViewKind = null,
    isReadOnly,
    isPreview,
    canPreview,
    activeTabPath,
    splitViewEnabled,
    hasRightPane,
    hasSavedPath,
    onAbout,
    currentLanguage,
    windowTitle,
}: MenuBarProps) {
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const menuBarRef = useRef<HTMLDivElement>(null);

    const closeMenu = () => setActiveMenu(null);
    const handleMenuClick = (menu: string) => setActiveMenu(activeMenu === menu ? null : menu);

    // Editor commands need a mounted Monaco instance — Markdown preview unmounts
    // it — and the mutating ones additionally need a writable buffer.
    const viewHasEditor = shownViewKind === 'compare' || shownViewKind === 'scratchpad';
    const canEdit = (hasActiveTab && !isPreview) || viewHasEditor;
    // Save, Close, Find and Go to Line also work on a view.
    const canRoute = hasActiveTab || shownViewKind !== null;
    const canWrite = canEdit && !isReadOnly;

    useEffect(() => {
        const root = menuBarRef.current;
        if (!root) return;
        root.querySelectorAll<HTMLElement>('.menu-item').forEach(item => {
            item.setAttribute('role', 'menuitem');
            item.setAttribute('tabindex', '0');
            item.setAttribute('aria-haspopup', 'menu');
            item.setAttribute('aria-expanded', String(item.querySelector('.menu-dropdown') !== null));
        });
        root.querySelectorAll<HTMLElement>('.menu-dropdown, .menu-dropdown-nested').forEach(menu => {
            menu.setAttribute('role', 'menu');
        });
        root.querySelectorAll<HTMLElement>('.menu-option, .menu-submenu').forEach(option => {
            option.setAttribute('role', 'menuitem');
            const disabled = option.classList.contains('disabled');
            option.setAttribute('tabindex', disabled ? '-1' : '0');
            if (disabled) option.setAttribute('aria-disabled', 'true');
        });
        root.querySelectorAll<HTMLElement>('.menu-submenu').forEach(submenu => {
            submenu.setAttribute('aria-haspopup', 'menu');
            submenu.setAttribute('aria-expanded', 'false');
        });
        root.querySelectorAll<HTMLElement>('.menu-divider').forEach(divider => {
            divider.setAttribute('role', 'separator');
        });
    }, [activeMenu]);

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const topLevelItems = Array.from(
            menuBarRef.current?.querySelectorAll<HTMLElement>(':scope > .menu-item') ?? [],
        );
        const topLevelItem = target.matches('.menu-item') ? target : null;
        if (
            target.matches('.menu-submenu')
            && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight')
        ) {
            event.preventDefault();
            openKeyboardSubmenu(target);
            return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && target.matches('.menu-item, .menu-option, .menu-submenu')) {
            event.preventDefault();
            target.click();
            return;
        }
        if (event.key === 'Escape') {
            menuBarRef.current?.querySelectorAll<HTMLElement>('.menu-submenu').forEach(submenu => {
                submenu.setAttribute('aria-expanded', 'false');
                submenu.querySelector(':scope > .menu-dropdown-nested')?.classList.remove('keyboard-open');
            });
            closeMenu();
            target.closest<HTMLElement>('.menu-item')?.focus();
            return;
        }
        if (event.key === 'ArrowDown' && topLevelItem) {
            event.preventDefault();
            if (!topLevelItem.querySelector('[role="menu"]')) topLevelItem.click();
            requestAnimationFrame(() => {
                const menu = topLevelItem.querySelector<HTMLElement>(':scope > [role="menu"]');
                if (menu) getDirectEnabledMenuItems(menu)[0]?.focus();
            });
            return;
        }
        if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && topLevelItem) {
            event.preventDefault();
            const current = topLevelItems.indexOf(topLevelItem);
            const direction = event.key === 'ArrowRight' ? 1 : -1;
            const next = topLevelItems[(current + direction + topLevelItems.length) % topLevelItems.length];
            next?.focus();
            if (activeMenu) next?.click();
            return;
        }
        if (event.key === 'ArrowLeft') {
            const nestedMenu = target.closest<HTMLElement>('.menu-dropdown-nested');
            if (nestedMenu) {
                event.preventDefault();
                const parent = nestedMenu.parentElement;
                nestedMenu.classList.remove('keyboard-open');
                parent?.setAttribute('aria-expanded', 'false');
                parent?.focus();
                return;
            }
        }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.closest('[role="menu"]')) {
            event.preventDefault();
            const menu = target.closest('[role="menu"]')!;
            const options = getDirectEnabledMenuItems(menu);
            const index = options.indexOf(target);
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            options[(index + direction + options.length) % options.length]?.focus();
        }
    };

    /* Windows runs the window undecorated, so this bar doubles as the titlebar:
       it owns the drag region, the document title and the window buttons.
       macOS and Linux keep the OS titlebar above and this stays a menu bar. */
    const customChrome = isWindows;
    // Spread rather than a bare attribute so decorated platforms get no drag
    // behaviour at all, instead of an inert attribute Tauri would still honour.
    const dragRegion = customChrome ? { 'data-tauri-drag-region': true } : {};

    return (
        <>
            {/* Row 1 — the titlebar we draw ourselves, so the document title can
                be centred on Windows too. Matches the redesign's 1b chrome. */}
            {customChrome && (
                <div className="titlebar" {...dragRegion}>
                    <span className="titlebar-title">{windowTitle}</span>
                    <WindowControls />
                </div>
            )}

            {/* Row 2 — the menu bar proper. */}
            <div className="menu-bar" {...dragRegion}>
                <div className="menu-brand" {...dragRegion}>
                    <span className="menu-brand-name">ZITEXT</span>
                </div>
                <div
                    className="menu-items"
                    ref={menuBarRef}
                    role="menubar"
                    aria-label="Application menu"
                    onKeyDown={handleMenuKeyDown}
                    onFocus={(event) => {
                        const submenu = (event.target as HTMLElement).closest<HTMLElement>('.menu-submenu');
                        submenu?.setAttribute('aria-expanded', 'true');
                    }}
                    onBlur={(event) => {
                        const submenu = (event.target as HTMLElement).closest<HTMLElement>('.menu-submenu');
                        if (submenu && !submenu.contains(event.relatedTarget as Node | null)) {
                            submenu.setAttribute('aria-expanded', 'false');
                            submenu.querySelector(':scope > .menu-dropdown-nested')?.classList.remove('keyboard-open');
                        }
                    }}
                >
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
                                    Open Folder... <span className="shortcut">{getShortcutDisplay('K')}</span>
                                </div>
                                <div className="menu-option" onClick={() => { onOpenLargeFile(); closeMenu(); }}>
                                    Open Large File or Log...
                                </div>
                                <div className="menu-divider" />
                                <div className={`menu-option ${!canRoute ? 'disabled' : ''}`} onClick={() => { if (canRoute) { onSave(); closeMenu(); } }}>
                                    Save <span className="shortcut">{getShortcutDisplay('S')}</span>
                                </div>
                                <div className={`menu-option ${!hasActiveTab ? 'disabled' : ''}`} onClick={() => { if (hasActiveTab) { onSaveAs(); closeMenu(); } }}>
                                    Save As... <span className="shortcut">{getShortcutDisplay('S', true, true)}</span>
                                </div>
                                <div className={`menu-option ${!hasSavedPath ? 'disabled' : ''}`} onClick={() => { if (hasSavedPath) { onRevertFile(); closeMenu(); } }}>
                                    Revert File
                                </div>
                                <div className={`menu-submenu ${!hasActiveTab ? 'disabled' : ''}`}>
                                    Compare
                                    {hasActiveTab && (
                                        <div className="menu-dropdown-nested">
                                            <div className="menu-option" onClick={() => { onCompareWithFile(); closeMenu(); }}>With File...</div>
                                            <div className="menu-option" onClick={() => { onCompareWithTab(); closeMenu(); }}>With Open Tab...</div>
                                            <div className="menu-option" onClick={() => { onCompareWithClipboard(); closeMenu(); }}>With Clipboard</div>
                                            <div className={`menu-option ${!hasSavedPath ? 'disabled' : ''}`} onClick={() => { if (hasSavedPath) { onCompareWithSaved(); closeMenu(); } }}>With Saved Version</div>
                                        </div>
                                    )}
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
                                <div className={`menu-option ${!canRoute ? 'disabled' : ''}`} onClick={() => { if (canRoute) { onClose(); closeMenu(); } }}>
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
                                {/* Undo…Select All mirror the macOS native menubar's PredefinedMenuItems,
                                    which the in-app menubar (Windows/Linux) has no equivalent for.
                                    They need a live editor, so preview mode disables them. */}
                                <div className={`menu-option ${!canEdit ? 'disabled' : ''}`} onClick={() => { if (canEdit) { onUndo(); closeMenu(); } }}>
                                    Undo <span className="shortcut">{getShortcutDisplay('Z')}</span>
                                </div>
                                <div className={`menu-option ${!canEdit ? 'disabled' : ''}`} onClick={() => { if (canEdit) { onRedo(); closeMenu(); } }}>
                                    Redo <span className="shortcut">{getShortcutDisplay('Z', true, true)}</span>
                                </div>
                                <div className="menu-divider" />
                                <div className={`menu-option ${!canWrite ? 'disabled' : ''}`} onClick={() => { if (canWrite) { onCut(); closeMenu(); } }}>
                                    Cut <span className="shortcut">{getShortcutDisplay('X')}</span>
                                </div>
                                <div className={`menu-option ${!canEdit ? 'disabled' : ''}`} onClick={() => { if (canEdit) { onCopy(); closeMenu(); } }}>
                                    Copy <span className="shortcut">{getShortcutDisplay('C')}</span>
                                </div>
                                <div className={`menu-option ${!canWrite ? 'disabled' : ''}`} onClick={() => { if (canWrite) { onPaste(); closeMenu(); } }}>
                                    Paste <span className="shortcut">{getShortcutDisplay('V')}</span>
                                </div>
                                <div className={`menu-option ${!canEdit ? 'disabled' : ''}`} onClick={() => { if (canEdit) { onSelectAll(); closeMenu(); } }}>
                                    Select All <span className="shortcut">{getShortcutDisplay('A')}</span>
                                </div>
                                <div className="menu-divider" />
                                <div className={`menu-option ${!canRoute ? 'disabled' : ''}`} onClick={() => { if (canRoute) { onFind(); closeMenu(); } }}>
                                    Find... <span className="shortcut">{getShortcutDisplay('F')}</span>
                                </div>
                                <div className={`menu-option ${!canRoute ? 'disabled' : ''}`} onClick={() => { if (canRoute) { onReplace(); closeMenu(); } }}>
                                    Find &amp; Replace... <span className="shortcut">{getShortcutDisplay('H')}</span>
                                </div>
                                <div className="menu-option" onClick={() => { onFindInFiles(); closeMenu(); }}>
                                    Find in Files... <span className="shortcut">{getShortcutDisplay('F', true, true)}</span>
                                </div>
                                <div className={`menu-option ${!canRoute ? 'disabled' : ''}`} onClick={() => { if (canRoute) { onGoToLine(); closeMenu(); } }}>
                                    Go to Line... <span className="shortcut">{getShortcutDisplay('G')}</span>
                                </div>
                                <div className="menu-divider" />
                                <div className={`menu-option ${!canWrite ? 'disabled' : ''}`} onClick={() => { if (canWrite) { onToggleLineComment(); closeMenu(); } }}>
                                    Toggle Line Comment <span className="shortcut">{getShortcutDisplay('/')}</span>
                                </div>
                                <div className={`menu-option ${!canWrite ? 'disabled' : ''}`} onClick={() => { if (canWrite) { onFormatDocument(); closeMenu(); } }}>
                                    {/* Monaco's own binding: Ctrl+Shift+I on Linux. (This menu bar is not shown on macOS.) */}
                                    Format Document <span className="shortcut">{isLinux ? 'Ctrl+Shift+I' : 'Shift+Alt+F'}</span>
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
                                <div className={`menu-option ${!canPreview && !isPreview ? 'disabled' : ''}`} onClick={() => { if (canPreview || isPreview) { onTogglePreview(); closeMenu(); } }}>
                                    {isPreview ? '✓ Toggle Markdown Preview' : 'Toggle Markdown Preview'} <span className="shortcut">{getShortcutDisplay('V', true, true)}</span>
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
                                {/* macOS gets an equivalent item injected by AppKit, so this is
                                    Windows/Linux only — matching its position at the menu's end. */}
                                <div className="menu-divider" />
                                <div className="menu-option" onClick={() => { onToggleFullScreen(); closeMenu(); }}>
                                    {isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'} <span className="shortcut">F11</span>
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

                    {/* Tools Menu */}
                    <div className="menu-item" onClick={() => handleMenuClick('tools')}>
                        Tools
                        {activeMenu === 'tools' && (
                            <div className="menu-dropdown" onMouseLeave={closeMenu}>
                                <div className="menu-option" onClick={() => { onOpenScratchpad(); closeMenu(); }}>
                                    Open Scratchpad <span className="shortcut">{getShortcutDisplay('N', true, true)}</span>
                                </div>
                                <div className="menu-divider" />
                                <div className="menu-group-label">Text and Data Tools</div>
                                {TOOL_GROUPS.map(({ group, label }) => (
                                    <div className="menu-submenu" key={group}>
                                        <span>{label}</span>
                                        <div className="menu-dropdown-nested">
                                            {TEXT_TOOLS.filter(tool => tool.group === group).map(tool => (
                                                <div key={tool.id} className="menu-option" title={tool.description}
                                                    onClick={() => { onTextTool(tool.id); closeMenu(); }}>
                                                    {tool.label}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                                <div className="menu-divider" />
                                <div className="menu-group-label">Marks</div>
                                <div className="menu-option" onClick={() => { onMarkSelection(); closeMenu(); }}>
                                    Mark Selection <span className="shortcut">{getShortcutDisplay('M', true, true)}</span>
                                </div>
                                <div className="menu-option" onClick={() => { onMarkFind(); closeMenu(); }}>Mark Find Matches</div>
                                <div className="menu-option" onClick={() => { onMarkText(); closeMenu(); }}>Mark Text...</div>
                                <div className="menu-option" onClick={() => { onMarkRegex(); closeMenu(); }}>Mark Regular Expression...</div>
                                <div className="menu-option" onClick={() => { onNextMark(); closeMenu(); }}>
                                    Next Marked <span className="shortcut">F4</span>
                                </div>
                                <div className="menu-option" onClick={() => { onPreviousMark(); closeMenu(); }}>
                                    Previous Marked <span className="shortcut">Shift+F4</span>
                                </div>
                                <div className="menu-option" onClick={() => { onClearMarks(); closeMenu(); }}>Clear All Marks</div>
                            </div>
                        )}
                    </div>

                    {/* Language Menu */}
                    <div className="menu-item" onClick={() => handleMenuClick('language')}>
                        Language
                        {activeMenu === 'language' && (
                            <div className="menu-dropdown" onMouseLeave={closeMenu}>
                                <div className="menu-group-label">{LANGUAGES.length} Modes</div>
                                {LANGUAGE_GROUPS.map(group => (
                                    <div className="menu-submenu" key={group.id}>
                                        <span>{group.label}</span>
                                        <div className="menu-dropdown-nested">
                                            {LANGUAGES.filter(language => language.group === group.id).map(({ id, label }) => (
                                                <LanguageOption key={id} id={id} label={label} current={currentLanguage} onPick={(lang) => { onChangeLanguage(lang); closeMenu(); }} />
                                            ))}
                                        </div>
                                    </div>
                                ))}
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
            </div>
        </>
    );
}
