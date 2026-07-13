import React, { useState, useEffect, useRef } from 'react';
import type { Settings } from '../types';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    settings: Settings;
    onSave: (settings: Partial<Settings>) => void;
}

const FONT_FAMILIES = [
    { value: '"Consolas", "Courier New", monospace', label: 'Consolas' },
    { value: '"Courier New", Courier, monospace', label: 'Courier New' },
    { value: '"Menlo", "Consolas", "JetBrains Mono", monospace', label: 'Menlo' },
    { value: '"Monaco", "Menlo", "Courier New", monospace', label: 'Monaco' },
    { value: '"JetBrains Mono", "Menlo", "Monaco", "Consolas", monospace', label: 'JetBrains Mono' },
    { value: '"Fira Code", "Menlo", "Monaco", "Consolas", monospace', label: 'Fira Code' },
    { value: '"Source Code Pro", "Menlo", "Monaco", "Consolas", monospace', label: 'Source Code Pro' },
    { value: '"Ubuntu Mono", "Courier New", Courier, monospace', label: 'Ubuntu Mono' },
    { value: '"Roboto Mono", "Courier New", Courier, monospace', label: 'Roboto Mono' },
    { value: '"Space Mono", "Courier New", Courier, monospace', label: 'Space Mono' },
    { value: '"Courier Prime", "Courier New", Courier, monospace', label: 'Courier Prime' },
    { value: 'monospace', label: 'System Monospace' },
];

const EDITOR_THEMES = [
    { value: 'vs', label: 'Light' },
    { value: 'vs-dark', label: 'Dark' },
    { value: 'hc-black', label: 'High Contrast Dark' },
    { value: 'hc-light', label: 'High Contrast Light' },
];

type SettingsTab = 'editor' | 'files' | 'privacy' | 'advanced';

const TABS: { key: SettingsTab; label: string; icon: string }[] = [
    { key: 'editor',   label: 'Editor',   icon: 'E' },
    { key: 'files',    label: 'Files',    icon: 'F' },
    { key: 'privacy',  label: 'Privacy',  icon: 'P' },
    { key: 'advanced', label: 'Advanced', icon: 'A' },
];

function Toggle({ checked, onChange, label, description }: {
    checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
    return (
        <div className="s-row s-row-toggle" onClick={() => onChange(!checked)}>
            <div className="s-row-text">
                <span className="s-row-label">{label}</span>
                {description && <span className="s-row-desc">{description}</span>}
            </div>
            <button
                role="switch"
                aria-checked={checked}
                className={`s-switch ${checked ? 'on' : ''}`}
                onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
            >
                <span className="s-switch-thumb" />
            </button>
        </div>
    );
}

interface DropdownOption { value: string | number; label: string; }

function Dropdown({ value, options, onChange, ariaLabel }: {
    value: string | number; options: DropdownOption[]; onChange: (v: string) => void; ariaLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const selected = options.find(o => String(o.value) === String(value));

    const openMenu = () => {
        const el = triggerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const margin = 8;
        const gap = 4;
        // Constrain to the modal's content area — measuring against the footer's top
        // (not the viewport) is what keeps the menu from ever spilling onto the buttons.
        const modal = el.closest('.s-modal');
        const footer = modal?.querySelector('.s-footer');
        const boundBottom = footer
            ? footer.getBoundingClientRect().top - margin
            : window.innerHeight - margin;
        const boundTop = modal
            ? modal.getBoundingClientRect().top + margin
            : margin;
        const spaceBelow = boundBottom - rect.bottom - gap;
        const spaceAbove = rect.top - boundTop - gap;
        // Flip up when there isn't enough room below and there's more above it.
        const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
        // maxHeight never exceeds the chosen side's space, so the menu stays inside
        // the content area on whichever side it opens.
        const maxHeight = Math.max(96, Math.min(280, openUp ? spaceAbove : spaceBelow));
        setMenuStyle({
            position: 'fixed',
            left: rect.left,
            width: rect.width,
            maxHeight,
            ...(openUp
                ? { bottom: window.innerHeight - rect.top + gap }
                : { top: rect.bottom + gap }),
        });
        setOpen(true);
    };

    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(false);
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        window.addEventListener('resize', close);
        window.addEventListener('scroll', close, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDown);
        return () => {
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('mousedown', onDown);
        };
    }, [open]);

    return (
        <div className="s-dropdown" ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className={`s-dropdown-trigger ${open ? 'open' : ''}`}
                onClick={() => (open ? setOpen(false) : openMenu())}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={ariaLabel}
            >
                <span className="s-dropdown-value">{selected?.label ?? ''}</span>
            </button>
            {open && (
                <ul className="s-dropdown-menu" role="listbox" style={menuStyle}>
                    {options.map(o => {
                        const isSel = String(o.value) === String(value);
                        return (
                            <li
                                key={String(o.value)}
                                role="option"
                                aria-selected={isSel}
                                className={`s-dropdown-option ${isSel ? 'selected' : ''}`}
                                onClick={() => { onChange(String(o.value)); setOpen(false); }}
                            >
                                {o.label}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function SelectRow({ label, value, onChange, options }: {
    label: string; value: string | number; onChange: (v: string) => void; options: DropdownOption[];
}) {
    return (
        <div className="s-row">
            <span className="s-row-label">{label}</span>
            <Dropdown value={value} options={options} onChange={onChange} ariaLabel={label} />
        </div>
    );
}

function NumberRow({ label, value, onChange, min, max, step }: {
    label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
    return (
        <div className="s-row">
            <span className="s-row-label">{label}</span>
            <input
                type="number"
                className="s-number"
                value={value}
                onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (!isNaN(v)) onChange(Math.max(min ?? 0, Math.min(max ?? 999, v)));
                }}
                min={min} max={max} step={step}
            />
        </div>
    );
}

function SectionHeader({ title }: { title: string }) {
    return <div className="s-section-header">{title}</div>;
}

function InfoBlock({ children }: { children: React.ReactNode }) {
    return <div className="s-info-block">{children}</div>;
}

export function SettingsModal({ isOpen, onClose, settings, onSave }: SettingsModalProps) {
    const [activeTab, setActiveTab] = useState<SettingsTab>('editor');
    const [theme, setTheme] = useState(settings.theme);
    const [fontFamily, setFontFamily] = useState(settings.fontFamily);
    const [fontSize, setFontSize] = useState(settings.fontSize);
    const [wordWrap, setWordWrap] = useState(settings.wordWrap);
    const [autosave, setAutosave] = useState(settings.autosave);
    const [autosaveDelay, setAutosaveDelay] = useState(settings.autosaveDelay);
    const [editorTheme, setEditorTheme] = useState(settings.editorTheme);
    const [showMinimap, setShowMinimap] = useState(settings.showMinimap);
    const [enableColumnSelection, setEnableColumnSelection] = useState(settings.enableColumnSelection);
    const [tabSize, setTabSize] = useState(settings.tabSize);
    const [insertSpaces, setInsertSpaces] = useState(settings.insertSpaces);
    const [formatOnSave, setFormatOnSave] = useState(settings.formatOnSave);
    const [checkForUpdates, setCheckForUpdates] = useState(settings.checkForUpdates);

    useEffect(() => {
        setTheme(settings.theme);
        setFontFamily(settings.fontFamily);
        setFontSize(settings.fontSize);
        setWordWrap(settings.wordWrap);
        setAutosave(settings.autosave);
        setAutosaveDelay(settings.autosaveDelay);
        setEditorTheme(settings.editorTheme);
        setShowMinimap(settings.showMinimap);
        setEnableColumnSelection(settings.enableColumnSelection);
        setTabSize(settings.tabSize);
        setInsertSpaces(settings.insertSpaces);
        setFormatOnSave(settings.formatOnSave);
        setCheckForUpdates(settings.checkForUpdates);
    }, [settings]);

    if (!isOpen) return null;

    const handleSave = () => {
        onSave({
            theme, fontFamily, fontSize, wordWrap, autosave, autosaveDelay,
            editorTheme, showMinimap, enableColumnSelection, tabSize,
            insertSpaces, formatOnSave, checkForUpdates,
        });
        onClose();
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="s-modal"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.key === 'Escape' && onClose()}
            >
                {/* Sidebar */}
                <nav className="s-sidebar">
                    <h2 className="s-sidebar-title">Settings</h2>
                    {TABS.map(t => (
                        <button
                            key={t.key}
                            className={`s-nav-item ${activeTab === t.key ? 'active' : ''}`}
                            onClick={() => setActiveTab(t.key)}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>

                {/* Content */}
                <div className="s-content">
                    <div className="s-content-scroll">
                        {activeTab === 'editor' && (
                            <>
                                <SectionHeader title="Appearance" />
                                <SelectRow label="Theme" value={theme} onChange={(v) => setTheme(v as 'light' | 'dark')}
                                    options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
                                <SelectRow label="Editor Theme" value={editorTheme} onChange={setEditorTheme} options={EDITOR_THEMES} />
                                <SelectRow label="Font Family" value={fontFamily} onChange={setFontFamily} options={FONT_FAMILIES} />
                                <NumberRow label="Font Size" value={fontSize} onChange={setFontSize} min={8} max={72} />

                                <SectionHeader title="Indentation" />
                                <SelectRow label="Tab Size" value={tabSize} onChange={(v) => setTabSize(parseInt(v))}
                                    options={[{ value: 2, label: '2 spaces' }, { value: 4, label: '4 spaces' }, { value: 8, label: '8 spaces' }]} />
                                <Toggle label="Insert Spaces" description="Use spaces instead of tab characters" checked={insertSpaces} onChange={setInsertSpaces} />

                                <SectionHeader title="Display" />
                                <Toggle label="Word Wrap" checked={wordWrap} onChange={setWordWrap} />
                                <Toggle label="Minimap" checked={showMinimap} onChange={setShowMinimap} />
                                <Toggle label="Column Selection" description="Alt+Shift+Drag for block selection" checked={enableColumnSelection} onChange={setEnableColumnSelection} />
                            </>
                        )}

                        {activeTab === 'files' && (
                            <>
                                <SectionHeader title="Saving" />
                                <SelectRow label="Autosave" value={autosave} onChange={(v) => setAutosave(v as 'off' | 'afterDelay' | 'onFocusChange')}
                                    options={[{ value: 'off', label: 'Off' }, { value: 'afterDelay', label: 'After Delay' }, { value: 'onFocusChange', label: 'On Focus Change' }]} />
                                {autosave === 'afterDelay' && (
                                    <NumberRow label="Delay (ms)" value={autosaveDelay} onChange={setAutosaveDelay} min={500} max={10000} step={500} />
                                )}
                                <Toggle label="Format on Save" description="Auto-format JSON/XML when saving" checked={formatOnSave} onChange={setFormatOnSave} />

                                <SectionHeader title="Defaults" />
                                <InfoBlock>
                                    <p>Encoding: <strong>UTF-8</strong></p>
                                    <p>Line Ending: <strong>LF (Unix)</strong></p>
                                </InfoBlock>
                            </>
                        )}

                        {activeTab === 'privacy' && (
                            <>
                                <SectionHeader title="Updates" />
                                <Toggle label="Check for updates" description="Checks zitext.com once per session. No personal data is sent." checked={checkForUpdates} onChange={setCheckForUpdates} />

                                <SectionHeader title="Data Handling" />
                                <InfoBlock>
                                    <p>ZITEXT does not collect telemetry, usage data, or crash reports.</p>
                                    <p>All files remain on your machine. No file content is ever sent to any server.</p>
                                    <p>The only network request is the optional update check above.</p>
                                </InfoBlock>
                            </>
                        )}

                        {activeTab === 'advanced' && (
                            <>
                                <SectionHeader title="Limits" />
                                <InfoBlock>
                                    <p>Large file warning: <strong>1 MB</strong></p>
                                    <p>Maximum file size: <strong>10 MB</strong></p>
                                    <p>File watcher interval: <strong>2 seconds</strong></p>
                                </InfoBlock>

                                <SectionHeader title="Shortcuts" />
                                <InfoBlock>
                                    <p>Customize keyboard shortcuts via <strong>Settings &rarr; Keyboard Shortcuts</strong></p>
                                </InfoBlock>

                                <SectionHeader title="About" />
                                <InfoBlock>
                                    <p><strong>ZITEXT Editor</strong></p>
                                    <p>A modern, lightweight text editor</p>
                                </InfoBlock>
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="s-footer">
                        <button className="s-btn s-btn-cancel" onClick={onClose}>Cancel</button>
                        <button className="s-btn s-btn-save" onClick={handleSave}>Save Changes</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
