import { useEffect, useMemo, useState } from 'react';
import { getLanguageDisplayName } from '../utils/languageDetection';
import { calculateTextStats, encodedByteLength, formatFileSize, formatNumber } from '../utils/textStats';
import { languageBadge } from '../utils/languageBadges';
import { useLiveCursor } from '../utils/liveCursor';

interface StatusBarProps {
    /** The focused tab: its live cursor position is shown (see liveCursor). */
    tabId: string;
    /** Its last settled position, shown until the editor reports a move. */
    line: number;
    column: number;
    language: string;
    encoding: string;
    eol: 'LF' | 'CRLF' | 'Mixed';
    /** The buffer; its counts and saved size settle after typing pauses. */
    content?: string;
    selectionLength?: number;
    fontSize: number;
    showMinimap: boolean;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onToggleMinimap: () => void;
    onChangeLanguage?: () => void;
}

export function StatusBar({
    tabId,
    line: settledLine,
    column: settledColumn,
    language,
    encoding,
    eol,
    content,
    selectionLength,
    fontSize,
    showMinimap,
    onZoomIn,
    onZoomOut,
    onToggleMinimap,
    onChangeLanguage,
}: StatusBarProps) {
    const { line, column } = useLiveCursor(tabId, { line: settledLine, column: settledColumn });
    const [statsContent, setStatsContent] = useState(content);
    useEffect(() => {
        if (content === undefined) {
            setStatsContent(undefined);
            return;
        }
        const timer = window.setTimeout(() => setStatsContent(content), 250);
        return () => window.clearTimeout(timer);
    }, [content]);

    // Keep live cursor/selection rendering cheap. Whole-document counts settle
    // after the typing burst instead of rescanning a large buffer per keystroke.
    const stats = useMemo(
        () => statsContent ? calculateTextStats(statsContent) : null,
        [statsContent],
    );
    const fileSize = useMemo(
        () => statsContent ? encodedByteLength(statsContent, encoding) : 0,
        [statsContent, encoding],
    );

    return (
        <div className="status-bar">
            <div className="status-left">
                <button
                    className="status-badge"
                    title="Select language mode"
                    aria-label="Select language mode"
                    onClick={onChangeLanguage}
                >
                    <span
                        className="status-lang-swatch"
                        style={{ '--lang-color': languageBadge(language)[1] } as React.CSSProperties}
                        aria-hidden="true"
                    />
                    {getLanguageDisplayName(language)}
                </button>
                <span className="status-item" title="Line Ending">
                    {eol}
                </span>
                <span className="status-item" title="Encoding">
                    {encoding}
                </span>
                {fileSize > 0 && (
                    <span className="status-item" title="File Size">
                        {formatFileSize(fileSize)}
                    </span>
                )}
                <button
                    className={`status-badge status-toggle ${showMinimap ? 'active' : ''}`}
                    onClick={onToggleMinimap}
                    title={showMinimap ? 'Hide Minimap' : 'Show Minimap'}
                >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="11" y="1" width="4" height="14" rx="1" opacity="0.3" />
                        <rect x="0" y="2" width="9" height="1.5" rx="0.5" />
                        <rect x="0" y="5" width="7" height="1.5" rx="0.5" />
                        <rect x="0" y="8" width="9" height="1.5" rx="0.5" />
                        <rect x="0" y="11" width="5" height="1.5" rx="0.5" />
                    </svg>
                    Minimap
                </button>
            </div>

            <div className="status-right">
                <span className="status-item" title="Line and Column">
                    Ln {line}, Col {column}
                </span>
                {stats && (
                    <span className="status-item" title="Character and Word Count">
                        {formatNumber(stats.chars)} ch &middot; {formatNumber(stats.words)} w
                    </span>
                )}
                {selectionLength !== undefined && selectionLength > 0 && (
                    <span className="status-item status-selection" title="Selected Characters">
                        {formatNumber(selectionLength)} selected
                    </span>
                )}
                <div className="status-zoom-modern" title="Font Size">
                    <button className="status-zoom-pill" onClick={onZoomOut} title="Decrease font size" aria-label="Decrease font size">−</button>
                    <span className="status-zoom-val">{fontSize}px</span>
                    <button className="status-zoom-pill" onClick={onZoomIn} title="Increase font size" aria-label="Increase font size">+</button>
                </div>
            </div>
        </div>
    );
}
