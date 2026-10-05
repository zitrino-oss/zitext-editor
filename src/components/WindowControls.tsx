import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/* Minimise / maximise / close for the undecorated Windows build. The window is
   borderless there (src-tauri/tauri.windows.conf.json), so nothing else draws
   these. Close goes through the normal window close request, which means the
   unsaved-changes interception in lib.rs still runs — this is not an exit. */
export function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        const win = getCurrentWindow();
        let unlisten: (() => void) | undefined;
        let disposed = false;

        const sync = () => {
            win.isMaximized()
                .then(value => { if (!disposed) setIsMaximized(value); })
                .catch(() => { /* non-fatal: the glyph keeps its last state */ });
        };

        sync();
        // Edge-snapping and the drag region's double-click both resize without
        // going through the buttons below, so track the window, not our clicks.
        win.onResized(sync).then(fn => {
            if (disposed) fn();
            else unlisten = fn;
        }).catch(() => { /* non-fatal */ });

        return () => { disposed = true; unlisten?.(); };
    }, []);

    const win = () => getCurrentWindow();

    return (
        <div className="window-controls">
            <button
                type="button"
                className="window-control"
                aria-label="Minimize"
                onClick={() => { void win().minimize(); }}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <line x1="0" y1="5" x2="10" y2="5" />
                </svg>
            </button>
            <button
                type="button"
                className="window-control"
                aria-label={isMaximized ? 'Restore' : 'Maximize'}
                onClick={() => { void win().toggleMaximize(); }}
            >
                {isMaximized ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                        <rect x="0.5" y="2.5" width="7" height="7" />
                        <path d="M2.5 2.5V0.5h7v7h-2" />
                    </svg>
                ) : (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                        <rect x="0.5" y="0.5" width="9" height="9" />
                    </svg>
                )}
            </button>
            <button
                type="button"
                className="window-control window-control-close"
                aria-label="Close"
                onClick={() => { void win().close(); }}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                    <line x1="0" y1="0" x2="10" y2="10" />
                    <line x1="10" y1="0" x2="0" y2="10" />
                </svg>
            </button>
        </div>
    );
}
