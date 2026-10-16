/**
 * A one-field prompt (Split Lines…, Mark Text…, Mark Regular Expression…),
 * with optional checkboxes. Enter submits, Escape cancels.
 */
import { useState } from 'react';
import { isImeComposing } from '../utils/shortcuts';

export interface PromptRequest {
    title: string;
    label: string;
    placeholder?: string;
    initial?: string;
    /** Checkboxes shown under the field, by key. */
    options?: { key: string; label: string; initial?: boolean }[];
    submitLabel: string;
    /** Returns an error to show, or nothing to close. */
    onSubmit: (value: string, options: Record<string, boolean>) => string | void | Promise<string | void>;
}

export function InputPrompt({ request, onClose }: { request: PromptRequest; onClose: () => void }) {
    const [value, setValue] = useState(request.initial ?? '');
    const [options, setOptions] = useState<Record<string, boolean>>(
        () => Object.fromEntries((request.options ?? []).map(option => [option.key, option.initial ?? false])),
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const problem = await request.onSubmit(value, options);
            if (problem) setError(problem);
            else onClose();
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal input-prompt" role="dialog" aria-modal="true" aria-label={request.title} onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title-group"><h3>{request.title}</h3></div>
                </div>
                <div className="modal-body">
                    <label className="input-prompt-label">
                        {request.label}
                        <input
                            className="log-input input-prompt-field"
                            autoFocus
                            value={value}
                            placeholder={request.placeholder}
                            onChange={e => { setValue(e.target.value); setError(null); }}
                            onKeyDown={e => {
                                // Enter that confirms an input-method conversion isn't a submit.
                                if (isImeComposing(e)) return;
                                if (e.key === 'Enter') { e.preventDefault(); void submit(); }
                                else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                            }}
                        />
                    </label>
                    {(request.options ?? []).map(option => (
                        <label key={option.key} className="log-check input-prompt-option">
                            <input type="checkbox" checked={options[option.key]} onChange={e => setOptions(current => ({ ...current, [option.key]: e.target.checked }))} />
                            {option.label}
                        </label>
                    ))}
                    {error && <p className="input-prompt-error" role="alert">{error}</p>}
                </div>
                <div className="modal-footer">
                    <button className="modal-button" onClick={onClose}>Cancel</button>
                    <button className="modal-button primary" onClick={() => void submit()} disabled={busy}>{request.submitLabel}</button>
                </div>
            </div>
        </div>
    );
}
