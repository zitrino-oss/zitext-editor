import { useEffect, useState } from 'react';

interface ExternalChangePromptProps {
    tabId: string;
    fileName: string;
    // A monotonically-increasing counter bumped each time the file is modified.
    // Using a counter (rather than just tabId) means the prompt reappears even
    // when the same tab is modified twice in a row.
    changeCount: number;
    isDeleted?: boolean;
    /** May return a promise; the banner stays until the change is resolved. */
    onReload: () => void | Promise<unknown>;
    onIgnore: () => void;
}

export function ExternalChangePrompt({
    tabId,
    fileName,
    changeCount,
    isDeleted = false,
    onReload,
    onIgnore,
}: ExternalChangePromptProps) {
    // The banner is shown for as long as the tab is marked as changed on disk.
    // It used to hide itself before Reload ran, so a cancelled or failed
    // reload left the conflict unresolved and invisible.
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setBusy(false);
    }, [tabId, changeCount]);

    const handleReload = () => {
        const result = onReload();
        if (result && typeof (result as Promise<unknown>).finally === 'function') {
            setBusy(true);
            void (result as Promise<unknown>).catch(() => {}).finally(() => setBusy(false));
        }
    };

    return (
        <div className="external-change-prompt">
            <div className="external-change-content">
                <span className="external-change-icon">⚠️</span>
                <span className="external-change-message">
                    <strong>{fileName}</strong> {isDeleted ? 'was deleted externally.' : 'has been modified externally.'}
                </span>
                <div className="external-change-actions">
                    <button
                        className="external-change-btn external-change-btn-primary"
                        onClick={handleReload}
                        disabled={busy}
                    >
                        {isDeleted ? 'Save Again' : 'Reload'}
                    </button>
                    <button
                        className="external-change-btn"
                        onClick={onIgnore}
                        disabled={busy}
                    >
                        Ignore
                    </button>
                </div>
            </div>
        </div>
    );
}
