import { useState, useEffect, useRef, useCallback } from 'react';
import type { editor } from 'monaco-editor';

interface FindReplaceBarProps {
    isOpen: boolean;
    showReplace: boolean;
    onClose: () => void;
    getEditor: () => editor.IStandaloneCodeEditor | null;
}

interface MatchState {
    total: number;
    current: number;
}

const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?_';

export function FindReplaceBar({ isOpen, showReplace, onClose, getEditor }: FindReplaceBarProps) {
    const [search, setSearch] = useState('');
    const [replace, setReplace] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [replaceVisible, setReplaceVisible] = useState(showReplace);
    const [matches, setMatches] = useState<MatchState>({ total: 0, current: 0 });
    const searchRef = useRef<HTMLInputElement>(null);
    const decorationsRef = useRef<string[]>([]);
    const matchRangesRef = useRef<editor.FindMatch[]>([]);
    const currentIdxRef = useRef(0);

    useEffect(() => { setReplaceVisible(showReplace); }, [showReplace]);

    // Focus + pre-fill on open
    useEffect(() => {
        if (!isOpen) return;
        setTimeout(() => {
            searchRef.current?.focus();
            searchRef.current?.select();
        }, 50);
        const ed = getEditor();
        if (ed) {
            const sel = ed.getSelection();
            if (sel && !sel.isEmpty()) {
                const text = ed.getModel()?.getValueInRange(sel) || '';
                if (text && !text.includes('\n')) setSearch(text);
            }
        }
    }, [isOpen]);

    // Clear decorations helper
    const clearDeco = useCallback(() => {
        const ed = getEditor();
        if (ed && decorationsRef.current.length > 0) {
            decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
        }
        matchRangesRef.current = [];
    }, [getEditor]);

    // Core search function
    const doSearch = useCallback((resetIndex = false) => {
        const ed = getEditor();
        if (!ed) return;
        const model = ed.getModel();
        if (!model || !search) {
            clearDeco();
            setMatches({ total: 0, current: 0 });
            return;
        }

        try {
            const found = model.findMatches(
                search, true, useRegex, matchCase,
                wholeWord ? WORD_SEPARATORS : null, true
            );
            matchRangesRef.current = found;

            if (resetIndex) currentIdxRef.current = 0;
            const idx = found.length > 0
                ? Math.min(currentIdxRef.current, found.length - 1)
                : 0;
            currentIdxRef.current = idx;

            // Apply decorations
            const decos = found.map((m, i) => ({
                range: m.range,
                options: {
                    className: i === idx ? 'fr-current-match' : 'fr-match',
                    overviewRuler: {
                        color: '#facc15',
                        position: 4 as unknown as editor.OverviewRulerLane,
                    },
                },
            }));
            decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decos);

            if (found.length > 0) {
                ed.setSelection(found[idx].range);
                ed.revealRangeInCenter(found[idx].range);
                setMatches({ total: found.length, current: idx + 1 });
            } else {
                setMatches({ total: 0, current: 0 });
            }
        } catch {
            // Invalid regex — show no results
            clearDeco();
            setMatches({ total: 0, current: 0 });
        }
    }, [search, matchCase, wholeWord, useRegex, getEditor, clearDeco]);

    // Re-run search when search text or options change
    useEffect(() => {
        if (isOpen) doSearch(true);
    }, [search, matchCase, wholeWord, useRegex, isOpen]);

    // Navigate matches
    const navigate = useCallback((dir: 1 | -1) => {
        const found = matchRangesRef.current;
        if (found.length === 0) return;
        let idx = currentIdxRef.current + dir;
        if (idx >= found.length) idx = 0;
        if (idx < 0) idx = found.length - 1;
        currentIdxRef.current = idx;
        doSearch();
    }, [doSearch]);

    const handleReplace = useCallback(() => {
        const ed = getEditor();
        const found = matchRangesRef.current;
        if (!ed || found.length === 0) return;
        const range = found[currentIdxRef.current].range;
        ed.executeEdits('find-replace', [{ range, text: replace }]);
        doSearch();
    }, [replace, getEditor, doSearch]);

    const handleReplaceAll = useCallback(() => {
        const ed = getEditor();
        const found = matchRangesRef.current;
        if (!ed || found.length === 0) return;
        const edits = [...found].reverse().map(m => ({ range: m.range, text: replace }));
        ed.executeEdits('find-replace-all', edits);
        currentIdxRef.current = 0;
        doSearch(true);
    }, [replace, getEditor, doSearch]);

    const handleClose = useCallback(() => {
        clearDeco();
        setSearch('');
        onClose();
        getEditor()?.focus();
    }, [clearDeco, onClose, getEditor]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose();
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            navigate(1);
        } else if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault();
            navigate(-1);
        }
    };

    if (!isOpen) return null;

    const noResults = search.length > 0 && matches.total === 0;

    return (
        <div className="fr-bar" onKeyDown={handleKeyDown}>
            <button
                className={`fr-toggle-btn ${replaceVisible ? 'open' : ''}`}
                onClick={() => setReplaceVisible(v => !v)}
                title={replaceVisible ? 'Hide Replace' : 'Show Replace'}
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            <div className="fr-fields">
                {/* Find row */}
                <div className="fr-row">
                    <div className={`fr-input-wrap ${noResults ? 'no-match' : ''}`}>
                        <input
                            ref={searchRef}
                            className="fr-input"
                            placeholder="Find"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            spellCheck={false}
                        />
                        <div className="fr-toggles">
                            <button className={`fr-opt ${matchCase ? 'active' : ''}`} onClick={() => setMatchCase(v => !v)} title="Match Case">Aa</button>
                            <button className={`fr-opt ${wholeWord ? 'active' : ''}`} onClick={() => setWholeWord(v => !v)} title="Whole Word">
                                <span style={{ textDecoration: 'underline', fontWeight: 700 }}>ab</span>
                            </button>
                            <button className={`fr-opt ${useRegex ? 'active' : ''}`} onClick={() => setUseRegex(v => !v)} title="Regex">.*</button>
                        </div>
                    </div>

                    <span className={`fr-count ${noResults ? 'no-match' : ''}`}>
                        {search ? `${matches.current} of ${matches.total}` : ''}
                    </span>

                    <div className="fr-actions">
                        <button className="fr-btn" onClick={() => navigate(-1)} title="Previous (Shift+Enter)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                        </button>
                        <button className="fr-btn" onClick={() => navigate(1)} title="Next (Enter)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <button className="fr-btn fr-close" onClick={handleClose} title="Close (Esc)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>
                    </div>
                </div>

                {/* Replace row */}
                {replaceVisible && (
                    <div className="fr-row">
                        <div className="fr-input-wrap">
                            <input
                                className="fr-input"
                                placeholder="Replace"
                                value={replace}
                                onChange={(e) => setReplace(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReplace(); }}}
                                spellCheck={false}
                            />
                        </div>
                        <div className="fr-actions">
                            <button className="fr-btn" onClick={handleReplace} title="Replace">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                </svg>
                            </button>
                            <button className="fr-btn" onClick={handleReplaceAll} title="Replace All">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17 20h4"/><path d="M11.5 15H7l-2 5L3.5 15"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
