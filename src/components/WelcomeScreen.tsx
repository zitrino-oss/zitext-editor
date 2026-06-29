import { isMac } from '../utils/shortcuts';
import { FileIcon } from '../utils/fileIcons';

interface WelcomeScreenProps {
    onNewFile: () => void;
    onOpenFile: () => void;
    onOpenFolder: () => void;
    recentFiles: string[];
    onOpenRecent: (path: string) => void;
}

const MOD = isMac ? '⌘' : 'Ctrl';

function Kbd({ children }: { children: string }) {
    return <kbd className="ws-kbd">{children}</kbd>;
}

export function WelcomeScreen({
    onNewFile,
    onOpenFile,
    onOpenFolder,
    recentFiles,
    onOpenRecent,
}: WelcomeScreenProps) {
    const getFileName = (p: string) => p.split(/[/\\]/).pop() || p;
    const getDirName = (p: string) => { const parts = p.split(/[/\\]/); parts.pop(); return parts.join('/') || '/'; };

    return (
        <div className="ws">
            <div className="ws-card">
            <div className="ws-inner">
                {/* Hero */}
                <div className="ws-hero">
                    <img src="/app-icon.png" alt="ZITEXT" className="ws-logo" />
                    <h1 className="ws-title">ZITEXT Editor</h1>
                    <p className="ws-subtitle">Fast, local-first text and code editor</p>
                </div>

                {/* Quick actions */}
                <div className="ws-actions">
                    <button className="ws-action" onClick={onNewFile}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
                        </svg>
                        <span>New File</span>
                        <span className="ws-action-hint"><Kbd>{MOD}</Kbd><Kbd>N</Kbd></span>
                    </button>
                    <button className="ws-action" onClick={onOpenFile}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9l-4 9z"/>
                        </svg>
                        <span>Open File</span>
                        <span className="ws-action-hint"><Kbd>{MOD}</Kbd><Kbd>O</Kbd></span>
                    </button>
                    <button className="ws-action" onClick={onOpenFolder}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                        </svg>
                        <span>Open Folder</span>
                        <span className="ws-action-hint"><Kbd>{MOD}</Kbd><Kbd>K</Kbd></span>
                    </button>
                </div>

                {/* Two columns: Recent Files + Shortcuts */}
                <div className="ws-grid">
                    {/* Recent files */}
                    {recentFiles.length > 0 && (
                        <div className="ws-section">
                            <h3 className="ws-section-title">Recent</h3>
                            <div className="ws-recent">
                                {recentFiles.slice(0, 6).map((path) => (
                                    <button key={path} className="ws-recent-item" onClick={() => onOpenRecent(path)} title={path}>
                                        <span className="ws-recent-icon"><FileIcon name={getFileName(path)} /></span>
                                        <div className="ws-recent-text">
                                            <span className="ws-recent-name">{getFileName(path)}</span>
                                            <span className="ws-recent-dir">{getDirName(path)}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Shortcuts */}
                    <div className="ws-section">
                        <h3 className="ws-section-title">Shortcuts</h3>
                        <div className="ws-shortcuts">
                            {[
                                ['New File',         [MOD, 'N']],
                                ['Open File',        [MOD, 'O']],
                                ['Save',             [MOD, 'S']],
                                ['Find',             [MOD, 'F']],
                                ['Find & Replace',   [MOD, 'H']],
                                ['Go to Line',       [MOD, 'G']],
                                ['Command Palette',  [MOD, '⇧', 'P']],
                                ['Find in Files',    [MOD, '⇧', 'F']],
                            ].map(([desc, keys]) => (
                                <div key={desc as string} className="ws-shortcut-row">
                                    <span className="ws-shortcut-label">{desc as string}</span>
                                    <span className="ws-shortcut-keys">
                                        {(keys as string[]).map((k, i) => <Kbd key={i}>{k}</Kbd>)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            </div>
        </div>
    );
}
