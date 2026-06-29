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
                    <h3>Unsaved Changes</h3>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>
                <div className="modal-body">
                    <p>
                        Do you want to save the changes you made to <strong>{fileName}</strong>?
                    </p>
                    <p style={{ marginTop: '8px', fontSize: '0.9em', opacity: 0.8 }}>
                        Your changes will be lost if you don't save them.
                    </p>
                </div>
                <div className="modal-footer">
                    <button
                        type="button"
                        className="modal-button"
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
                    </button>
                </div>
            </div>
        </div>
    );
}
