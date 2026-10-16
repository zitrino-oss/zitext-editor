import { invoke } from '@tauri-apps/api/core';
import type { UpdateInfo } from '../hooks/useUpdateChecker';

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

    function handleDownload() {
        // open_url_in_browser is restricted to https://zitext.com on the backend.
        invoke('open_url_in_browser', { url: DOWNLOADS_URL }).catch(console.error);
        onLater();
    }

    // Later, Download, × and Escape put the prompt off for this session; only
    // "Skip this version" is remembered (onSkip). The dialog itself takes
    // focus, not a button, because it appears on its own a few seconds after
    // launch and a stray Enter must not act on it.
    return (
        // Escape (handled centrally) and a click outside both mean "Later".
        <div className="modal-overlay" onClick={onLater}>
            <div className="modal update-modal" data-focus-dialog onClick={(e) => e.stopPropagation()}>
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
                    <button type="button" className="modal-button" onClick={onSkip}>
                        Skip this version
                    </button>
                    <button type="button" className="modal-button" onClick={onLater}>
                        Remind me later
                    </button>
                    <button type="button" className="modal-button primary" onClick={handleDownload}>
                        Download
                    </button>
                </div>
            </div>
        </div>
    );
}
