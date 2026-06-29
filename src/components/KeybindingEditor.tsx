import { useState } from 'react';

interface KeybindingEditorProps {
    isOpen: boolean;
    onClose: () => void;
    keybindings: Record<string, string>;
    onSave: (keybindings: Record<string, string>) => void;
}

interface CommandDef {
    id: string;
    label: string;
    defaultKey: string;
}

const isMac = typeof window !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent);
const mod = isMac ? 'Cmd' : 'Ctrl';

const COMMANDS: CommandDef[] = [
    { id: 'new', label: 'New File', defaultKey: `${mod}+N` },
    { id: 'open', label: 'Open File', defaultKey: `${mod}+O` },
    { id: 'save', label: 'Save', defaultKey: `${mod}+S` },
    { id: 'saveAs', label: 'Save As', defaultKey: `${mod}+Shift+S` },
    { id: 'close', label: 'Close Tab', defaultKey: `${mod}+W` },
    { id: 'find', label: 'Find', defaultKey: `${mod}+F` },
    { id: 'replace', label: 'Find & Replace', defaultKey: `${mod}+H` },
    { id: 'goToLine', label: 'Go to Line', defaultKey: `${mod}+G` },
    { id: 'commandPalette', label: 'Command Palette', defaultKey: `${mod}+Shift+P` },
    { id: 'wordWrap', label: 'Toggle Word Wrap', defaultKey: 'Alt+Z' },
];

/** Render a key combo as styled <kbd> pills */
function KeyCombo({ combo }: { combo: string }) {
    const parts = combo.split('+');
    return (
        <span className="kb-combo">
            {parts.map((part, i) => (
                <kbd key={i} className="kb-key">{part}</kbd>
            ))}
        </span>
    );
}

export function KeybindingEditor({ isOpen, onClose, keybindings, onSave }: KeybindingEditorProps) {
    const [editedBindings, setEditedBindings] = useState<Record<string, string>>(keybindings);
    const [editingCommand, setEditingCommand] = useState<string | null>(null);

    if (!isOpen) return null;

    const handleKeyCapture = (commandId: string, e: React.KeyboardEvent) => {
        e.preventDefault();
        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push(mod);
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        let key = e.key;
        if (key === ' ') key = 'Space';
        else if (key.length === 1) key = key.toUpperCase();
        if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return;
        parts.push(key);
        setEditedBindings(prev => ({ ...prev, [commandId]: parts.join('+') }));
        setEditingCommand(null);
    };

    const handleReset = (commandId: string) => {
        const command = COMMANDS.find(c => c.id === commandId);
        if (command) setEditedBindings(prev => ({ ...prev, [commandId]: command.defaultKey }));
    };

    const handleResetAll = () => {
        const defaults: Record<string, string> = {};
        COMMANDS.forEach(cmd => { defaults[cmd.id] = cmd.defaultKey; });
        setEditedBindings(defaults);
    };

    const handleSave = () => {
        const bindingValues = COMMANDS.map(c => getBinding(c.id));
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const b of bindingValues) {
            if (seen.has(b)) duplicates.add(b);
            else seen.add(b);
        }
        if (duplicates.size > 0) {
            const list = Array.from(duplicates).join(', ');
            if (!window.confirm(`Duplicate shortcuts: ${list}\n\nSave anyway?`)) return;
        }
        onSave(editedBindings);
        onClose();
    };

    const getBinding = (commandId: string) =>
        editedBindings[commandId] || COMMANDS.find(c => c.id === commandId)?.defaultKey || '';

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="kb-modal" onClick={(e) => e.stopPropagation()}>
                <div className="kb-header">
                    <div>
                        <h2 className="kb-title">Keyboard Shortcuts</h2>
                        <p className="kb-subtitle">Click a shortcut to reassign it</p>
                    </div>
                    <button className="kb-close" onClick={onClose}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <div className="kb-list">
                    <div className="kb-list-header">
                        <span>Command</span>
                        <span>Shortcut</span>
                    </div>
                    {COMMANDS.map(command => {
                        const isEditing = editingCommand === command.id;
                        const binding = getBinding(command.id);
                        const isCustom = editedBindings[command.id] && editedBindings[command.id] !== command.defaultKey;
                        return (
                            <div key={command.id} className={`kb-row ${isEditing ? 'editing' : ''}`}>
                                <span className="kb-label">
                                    {command.label}
                                    {isCustom && <span className="kb-custom-dot" title="Custom binding" />}
                                </span>
                                <div className="kb-action">
                                    {isEditing ? (
                                        <input
                                            className="kb-capture"
                                            value="Press keys..."
                                            onKeyDown={(e) => handleKeyCapture(command.id, e)}
                                            onBlur={() => setEditingCommand(null)}
                                            autoFocus
                                            readOnly
                                        />
                                    ) : (
                                        <button
                                            className="kb-binding-btn"
                                            onClick={() => setEditingCommand(command.id)}
                                            title="Click to change"
                                        >
                                            <KeyCombo combo={binding} />
                                        </button>
                                    )}
                                    <button
                                        className="kb-reset"
                                        onClick={() => handleReset(command.id)}
                                        title="Reset to default"
                                    >
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 105.64-11.36L1 10" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>

                <div className="kb-footer">
                    <button className="s-btn s-btn-cancel" onClick={handleResetAll}>Reset All</button>
                    <div className="kb-footer-right">
                        <button className="s-btn s-btn-cancel" onClick={onClose}>Cancel</button>
                        <button className="s-btn s-btn-save" onClick={handleSave}>Save</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
