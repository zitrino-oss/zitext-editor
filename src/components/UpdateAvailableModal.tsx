import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { UpdateInfo } from '../hooks/useUpdateChecker';

const SKIPPED_KEY_PREFIX = 'update_skipped_v';
const DOWNLOADS_URL = 'https://zitext.com/downloads.html';

interface UpdateAvailableModalProps {
    update: UpdateInfo;
    onLater: () => void;
    onSkip: () => void;
}

/**
 * Notifies the user that a newer version is available and links to the
 * downloads page. Updates are installed by downloading the latest build from
 * the website rather than in-app.
 */
export function UpdateAvailableModal({ update, onLater, onSkip }: UpdateAvailableModalProps) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onLater();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onLater]);

    function handleDownload() {
        // open_url_in_browser is restricted to https://zitext.com on the backend.
        invoke('open_url_in_browser', { url: DOWNLOADS_URL }).catch(console.error);
        onLater();
    }

    function handleSkip() {
        // Remember this version so we don't prompt again unless a newer one ships.
        try { localStorage.setItem(`${SKIPPED_KEY_PREFIX}${update.version}`, '1'); }
        catch (_) { /* private browsing — best effort */ }
        onSkip();
    }

    return (
        <div className="modal-overlay">
            <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>Update available</h3>
                    <button className="modal-close" onClick={onLater} aria-label="Close">×</button>
                </div>

                <div className="modal-body">
                    <p><strong>ZITEXT {update.version}</strong> is available.</p>
                    {update.releaseDate && (
                        <p style={{ marginTop: '6px', fontSize: '0.9em', opacity: 0.8 }}>
                            Released {update.releaseDate}
                        </p>
                    )}
                    <p style={{ marginTop: '12px' }}>
                        Download the latest version from our website to get the newest fixes and features.
                    </p>
                </div>

                <div className="modal-footer">
                    <button type="button" className="modal-button" onClick={handleSkip}>
                        Skip this version
                    </button>
                    <button type="button" className="modal-button" onClick={onLater}>
                        Remind me later
                    </button>
                    <button type="button" className="modal-button primary" onClick={handleDownload} autoFocus>
                        Download
                    </button>
                </div>
            </div>
        </div>
    );
}
