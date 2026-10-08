import { useEffect, useState } from 'react';
import { ask } from '@tauri-apps/plugin-dialog';
import { requiresShortcutModifier, shortcutKeyOf } from '../utils/shortcuts';
import { COMMANDS, FIXED_SHORTCUTS, mod } from '../utils/commandRegistry';

interface KeybindingEditorProps {
    isOpen: boolean;
    onClose: () => void;
    keybindings: Record<string, string>;
    onSave: (keybindings: Record<string, string>) => void;
}

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
    const [captureError, setCaptureError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        setEditedBindings(keybindings);
        setEditingCommand(null);
        setCaptureError(null);
    }, [isOpen, keybindings]);

    if (!isOpen) return null;

    const handleKeyCapture = (commandId: string, e: React.KeyboardEvent) => {
        if (e.key === 'Tab') {
            setEditingCommand(null);
            return;
        }
        e.preventDefault();
        if (['Escape', 'Backspace', 'Delete'].includes(e.key)) {
            setEditingCommand(null);
            setCaptureError(null);
            return;
        }
        const parts: string[] = [];
        if (e.ctrlKey || e.metaKey) parts.push(mod);
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        // The physical key for letters and digits, as the shortcut matcher
        // uses: Option on macOS and non-Latin layouts change e.key ("Ƒ", "Ы"),
        // and a binding recorded that way never fired.
        const physical = shortcutKeyOf(e.nativeEvent);
        let key = e.key;
        if (key === ' ') key = 'Space';
        // "+" is the separator in stored bindings, so the key is named.
        else if (physical === '+') key = 'Plus';
        else if (physical.length === 1) key = physical.toUpperCase();
        if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) return;
        if (requiresShortcutModifier(key) && !(e.ctrlKey || e.metaKey || e.altKey)) {
            setCaptureError('Typing and navigation keys require Ctrl/Cmd or Alt so editor input remains available.');
            return;
        }
        parts.push(key);
        const fixedOwner = FIXED_SHORTCUTS[parts.join('+')];
        if (fixedOwner) {
            setCaptureError(`${parts.join('+')} is already used by ${fixedOwner} and can't be reassigned.`);
            return;
        }
        setCaptureError(null);
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

    const handleSave = async () => {
        const bindingValues = COMMANDS.map(c => getBinding(c.id));
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const b of bindingValues) {
            if (seen.has(b)) duplicates.add(b);
            else seen.add(b);
        }
        if (duplicates.size > 0) {
            const list = Array.from(duplicates).join(', ');
            const confirmed = await ask(`Duplicate shortcuts: ${list}\n\nSave anyway?`, {
                title: 'Duplicate Shortcuts',
                kind: 'warning',
                okLabel: 'Save Anyway',
                cancelLabel: 'Cancel',
            });
            if (!confirmed) return;
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
                        <p className="kb-subtitle">
                            Click a binding, then press the new combination.
                        </p>
                    </div>
                    <button className="kb-close" onClick={onClose} aria-label="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                <div className="kb-list">
                    {captureError && <p className="kb-capture-error" role="alert">{captureError}</p>}
                    <div className="kb-list-header">
                        <span>Command</span>
                        <span>Binding</span>
                    </div>
                    {COMMANDS.map(command => {
                        const isEditing = editingCommand === command.id;
                        const binding = getBinding(command.id);
                        const isCustom = editedBindings[command.id] && editedBindings[command.id] !== command.defaultKey;
                        return (
                            <div key={command.id} className={`kb-row ${isEditing ? 'editing' : ''}`}>
                                <span className="kb-label">
                                    {/* Leading marker: the row being captured, or one whose
                                        binding has been changed from the default. Always
                                        rendered so the label text does not shift when it
                                        appears mid-capture. */}
                                    <span
                                        className={`kb-custom-dot${isEditing || isCustom ? ' visible' : ''}`}
                                        title={isEditing ? 'Awaiting new binding' : 'Custom binding'}
                                        aria-hidden="true"
                                    />
                                    {command.label}
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
                    <button className="s-btn s-btn-cancel" onClick={handleResetAll}>Reset all</button>
                    <div className="kb-footer-right">
                        <button className="s-btn s-btn-cancel" onClick={onClose}>Cancel</button>
                        <button className="s-btn s-btn-save" onClick={handleSave}>Done</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
