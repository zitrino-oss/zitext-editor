import { useEffect } from 'react';

interface UnsavedChangesModalProps {
    isOpen: boolean;
    fileName: string;
    onSave: () => void;
    onDontSave: () => void;
    onCancel: () => void;
}

export function UnsavedChangesModal({
    isOpen,
    fileName,
    onSave,
    onDontSave,
    onCancel
}: UnsavedChangesModalProps) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isOpen) return;

            if (e.key === 'Escape') {
                onCancel();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onCancel]);

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title-group">
                        <span className="modal-icon-badge warning" aria-hidden="true" />
                        <h3>Unsaved Changes</h3>
                    </div>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>
                <div className="modal-body indented">
                    <p>
                        Do you want to save the changes you made to <strong>{fileName}</strong>?
                    </p>
                    <p>
                        Your changes will be lost if you don't save them.
                    </p>
                </div>
                <div className="modal-footer">
                    <button
                        type="button"
                        className="modal-button danger"
                        onClick={onDontSave}
                    >
                        Don't Save
                    </button>
                    <button
                        type="button"
                        className="modal-button"
                        onClick={onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="modal-button primary"
                        onClick={onSave}
                        autoFocus
                    >
                        Save
                        <svg className="modal-button-key" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
