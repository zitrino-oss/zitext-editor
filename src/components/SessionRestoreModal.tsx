import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Modal shown at startup when the last session has file-backed tabs.
 *
 * The Rust startup task stashes the file list and emits
 * `session-restore-prompt` (with the file count). The user's choice is sent
 * back via `confirm_session_restore`, which is what actually grants the
 * paths and unblocks `get_last_session` for the renderer's restore code.
 *
 * The dialog cannot be dismissed without choosing (no Esc, no click-outside)
 * because `get_last_session` is currently awaiting the decision and the rest
 * of the app's startup is stalled on it.
 */
export function SessionRestoreModal() {
    const [open, setOpen] = useState(false);
    const [fileCount, setFileCount] = useState(0);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen<{ fileCount: number }>('session-restore-prompt', (event) => {
            setFileCount(event.payload?.fileCount ?? 0);
            setOpen(true);
        }).then((un) => { unlisten = un; });
        return () => { if (unlisten) unlisten(); };
    }, []);

    async function choose(restore: boolean) {
        if (submitting) return;
        setSubmitting(true);
        try {
            await invoke('confirm_session_restore', { restore });
        } catch (err) {
            console.error('confirm_session_restore failed:', err);
        }
        setOpen(false);
        setSubmitting(false);
    }

    if (!open) return null;

    const label = fileCount === 1 ? 'file' : 'files';

    return (
        <div className="modal-overlay">
            <div
                className="modal session-restore-modal"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: '440px', minWidth: '360px' }}
            >
                <div className="modal-body" style={{ textAlign: 'center', padding: '28px 24px 16px' }}>
                    <div
                        aria-hidden="true"
                        style={{
                            width: '48px',
                            height: '48px',
                            margin: '0 auto 14px',
                            borderRadius: '50%',
                            background: 'var(--bg-tertiary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--accent-color)',
                        }}
                    >
                        {/* Document-with-clock info glyph — neutral, not an alert */}
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <circle cx="12" cy="15" r="3" />
                            <path d="M12 13.5v1.5l1 .8" />
                        </svg>
                    </div>

                    <h3 style={{ margin: 0, fontSize: '1.1em', fontWeight: 600 }}>
                        Restore previous session?
                    </h3>

                    <p
                        style={{
                            marginTop: '8px',
                            fontSize: '0.95em',
                            color: 'var(--text-secondary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        Restore {fileCount} {label} from your last session?
                    </p>
                </div>

                <div className="modal-footer" style={{ justifyContent: 'center', gap: '10px' }}>
                    <button
                        type="button"
                        className="modal-button"
                        onClick={() => choose(false)}
                        disabled={submitting}
                    >
                        Skip
                    </button>
                    <button
                        type="button"
                        className="modal-button primary"
                        onClick={() => choose(true)}
                        disabled={submitting}
                        autoFocus
                    >
                        Restore
                    </button>
                </div>
            </div>
        </div>
    );
}
