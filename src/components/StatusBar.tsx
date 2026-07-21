import { useEffect, useMemo, useState } from 'react';
import { getLanguageDisplayName } from '../utils/languageDetection';
import { calculateTextStats, formatFileSize, formatNumber } from '../utils/textStats';

interface StatusBarProps {
    line: number;
    column: number;
    language: string;
    encoding: string;
    eol: 'LF' | 'CRLF';
    fileSize?: number;
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
    line,
    column,
    language,
    encoding,
    eol,
    fileSize,
    content,
    selectionLength,
    fontSize,
    showMinimap,
    onZoomIn,
    onZoomOut,
    onToggleMinimap,
    onChangeLanguage,
}: StatusBarProps) {
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

    return (
        <div className="status-bar">
            <div className="status-left">
                <button
                    className="status-badge"
                    title="Select language mode"
                    onClick={onChangeLanguage}
                >
                    {getLanguageDisplayName(language)}
                </button>
                <span className="status-item" title="Line Ending">
                    {eol}
                </span>
                <span className="status-item" title="Encoding">
                    {encoding}
                </span>
                {fileSize !== undefined && fileSize > 0 && (
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
                        {formatNumber(stats.chars)} chars &middot; {formatNumber(stats.words)} words
                    </span>
                )}
                {selectionLength !== undefined && selectionLength > 0 && (
                    <span className="status-item status-selection" title="Selected Characters">
                        {formatNumber(selectionLength)} selected
                    </span>
                )}
                <div className="status-zoom-modern" title="Font Size">
                    <button className="status-zoom-pill" onClick={onZoomOut} title="Decrease font size">−</button>
                    <span className="status-zoom-val">{fontSize}px</span>
                    <button className="status-zoom-pill" onClick={onZoomIn} title="Increase font size">+</button>
                </div>
            </div>
        </div>
    );
}
