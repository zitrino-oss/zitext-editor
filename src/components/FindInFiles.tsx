import { useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface SearchMatch {
    file_path: string;
    line_number: number;
    line_content: string;
    match_start: number;
    match_end: number;
}

interface GroupedResult {
    filePath: string;
    fileName: string;
    matches: SearchMatch[];
}

interface FindInFilesProps {
    folderPath: string | null;
    onOpenFile: (path: string, line: number) => void;
    onOpenFolder: () => void;
    onClose: () => void;
}

export function FindInFiles({ folderPath, onOpenFile, onOpenFolder, onClose }: FindInFilesProps) {
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [results, setResults] = useState<GroupedResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [totalMatches, setTotalMatches] = useState(0);
    const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
    // The query an actual search was last run for. Distinct from `query` (the live
    // input) so "No results found" only appears after a search has run — not on every
    // keystroke before the user presses Enter / clicks Search.
    const [searchedQuery, setSearchedQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const runSearch = useCallback(async (q: string, cs: boolean, ww: boolean) => {
        if (!folderPath || !q.trim()) {
            setResults([]);
            setTotalMatches(0);
            setSearchedQuery('');
            return;
        }

        setIsSearching(true);
        setSearchError(null);

        try {
            const matches = await invoke<SearchMatch[]>('search_in_files', {
                folder: folderPath,
                query: q,
                caseSensitive: cs,
                wholeWord: ww,
            });

            // Group by file
            const grouped = new Map<string, SearchMatch[]>();
            for (const m of matches) {
                const existing = grouped.get(m.file_path) || [];
                existing.push(m);
                grouped.set(m.file_path, existing);
            }

            const groupedResults: GroupedResult[] = Array.from(grouped.entries()).map(([fp, ms]) => ({
                filePath: fp,
                fileName: fp.split(/[/\\]/).pop() || fp,
                matches: ms,
            }));

            setResults(groupedResults);
            setTotalMatches(matches.length);
            setSearchedQuery(q);
        } catch (err) {
            setSearchError((err as Error).message || String(err));
            setResults([]);
            setTotalMatches(0);
            setSearchedQuery(q);
        } finally {
            setIsSearching(false);
        }
    }, [folderPath]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            runSearch(query, caseSensitive, wholeWord);
        }
    };

    const toggleCollapse = (filePath: string) => {
        setCollapsedFiles(prev => {
            const next = new Set(prev);
            if (next.has(filePath)) next.delete(filePath);
            else next.add(filePath);
            return next;
        });
    };

    const highlightMatch = (line: string, start: number, end: number) => {
        const before = line.slice(0, start);
        const match = line.slice(start, end);
        const after = line.slice(end);
        // Truncate long lines for display
        const maxLen = 80;
        const displayBefore = before.length > 30 ? '…' + before.slice(-27) : before;
        const displayAfter = after.length > maxLen - displayBefore.length - match.length
            ? after.slice(0, maxLen - displayBefore.length - match.length) + '…'
            : after;
        return { before: displayBefore, match, after: displayAfter };
    };

    if (!folderPath) {
        return (
            <div className="find-in-files">
                <div className="find-in-files-header">
                    <span className="file-explorer-title">SEARCH</span>
                    <button className="file-explorer-action-btn" onClick={onClose} title="Close Search">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div className="find-in-files-empty">
                    <p>Open a folder to search across files.</p>
                    <button className="file-explorer-open-btn" onClick={onOpenFolder}>Open Folder</button>
                </div>
            </div>
        );
    }

    return (
        <div className="find-in-files">
            <div className="find-in-files-header">
                <span className="file-explorer-title">SEARCH</span>
                <button className="file-explorer-action-btn" onClick={onClose} title="Close Search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>

            <div className="find-in-files-controls">
                <div className="find-in-files-input-row">
                    <input
                        ref={inputRef}
                        type="text"
                        className="find-in-files-input"
                        placeholder="Search in files… (Enter)"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                    <button
                        className="find-in-files-search-btn"
                        onClick={() => runSearch(query, caseSensitive, wholeWord)}
                        title="Search (Enter)"
                        disabled={isSearching}
                    >
                        {isSearching ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spinning">
                                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                            </svg>
                        ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8"/>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                            </svg>
                        )}
                    </button>
                </div>

                <div className="find-in-files-options">
                    <button
                        className={`find-option-btn ${caseSensitive ? 'active' : ''}`}
                        onClick={() => { const next = !caseSensitive; setCaseSensitive(next); if (query) runSearch(query, next, wholeWord); }}
                        title="Match Case"
                    >
                        Aa
                    </button>
                    <button
                        className={`find-option-btn ${wholeWord ? 'active' : ''}`}
                        onClick={() => { const next = !wholeWord; setWholeWord(next); if (query) runSearch(query, caseSensitive, next); }}
                        title="Match Whole Word"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="4 7 4 4 20 4 20 7"/>
                            <line x1="9" y1="20" x2="15" y2="20"/>
                            <line x1="12" y1="4" x2="12" y2="20"/>
                        </svg>
                    </button>
                </div>
            </div>

            {searchError && (
                <div className="find-in-files-error">{searchError}</div>
            )}

            {totalMatches > 0 && (
                <div className="find-in-files-summary">
                    {totalMatches} result{totalMatches !== 1 ? 's' : ''} in {results.length} file{results.length !== 1 ? 's' : ''}
                    {totalMatches >= 500 && ' (limit reached)'}
                </div>
            )}

            {results.length === 0 && searchedQuery && !isSearching && !searchError && (
                <div className="find-in-files-no-results">No results found for "{searchedQuery}"</div>
            )}

            <div className="find-in-files-results">
                {results.map((group) => {
                    const isCollapsed = collapsedFiles.has(group.filePath);
                    return (
                        <div key={group.filePath} className="find-result-group">
                            <button
                                className="find-result-file"
                                onClick={() => toggleCollapse(group.filePath)}
                                title={group.filePath}
                            >
                                <span className="find-result-file-arrow">{isCollapsed ? '▶' : '▼'}</span>
                                <span className="find-result-file-name">{group.fileName}</span>
                                <span className="find-result-file-count">{group.matches.length}</span>
                            </button>
                            {!isCollapsed && (
                                <div className="find-result-matches">
                                    {group.matches.map((match, i) => {
                                        // Only leading whitespace is stripped by trimStart; compute
                                        // the offset once and apply it to both start and end.
                                        const leadingStripped = match.line_content.length - match.line_content.trimStart().length;
                                        const adjustedStart = Math.max(0, match.match_start - leadingStripped);
                                        const adjustedEnd = Math.max(adjustedStart, match.match_end - leadingStripped);
                                        const { before, match: m, after } = highlightMatch(
                                            match.line_content.trimStart(),
                                            adjustedStart,
                                            adjustedEnd,
                                        );
                                        return (
                                            <button
                                                key={i}
                                                className="find-result-match"
                                                onClick={() => onOpenFile(match.file_path, match.line_number)}
                                                title={`Line ${match.line_number}`}
                                            >
                                                <span className="find-result-line-num">{match.line_number}</span>
                                                <span className="find-result-line-content">
                                                    <span>{before}</span>
                                                    <mark className="find-result-highlight">{m}</mark>
                                                    <span>{after}</span>
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
