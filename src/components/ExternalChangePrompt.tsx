import { useEffect, useState } from 'react';

interface ExternalChangePromptProps {
    tabId: string;
    fileName: string;
    // A monotonically-increasing counter bumped each time the file is modified.
    // Using a counter (rather than just tabId) means the prompt reappears even
    // when the same tab is modified twice in a row.
    changeCount: number;
    isDeleted?: boolean;
    onReload: () => void;
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
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        setVisible(true);
    }, [tabId, changeCount]);

    const handleReload = () => {
        setVisible(false);
        onReload();
    };

    const handleIgnore = () => {
        setVisible(false);
        onIgnore();
    };

    if (!visible) {
        return null;
    }

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
                    >
                        {isDeleted ? 'Save Again' : 'Reload'}
                    </button>
                    <button
                        className="external-change-btn"
                        onClick={handleIgnore}
                    >
                        Ignore
                    </button>
                </div>
            </div>
        </div>
    );
}
