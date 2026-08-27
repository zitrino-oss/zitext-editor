import { useState, useEffect, useRef, useCallback } from 'react';
import { editor } from 'monaco-editor';
import {
    clearPreviewHighlights,
    highlightPreviewMatches,
    setCurrentPreviewMatch,
} from '../utils/previewSearch';

interface FindReplaceBarProps {
    isOpen: boolean;
    showReplace: boolean;
    onClose: () => void;
    getEditor: () => editor.IStandaloneCodeEditor | null;
    /**
     * The rendered Markdown body, when the focused tab is previewing. Monaco is
     * unmounted in that mode, so the search runs against this DOM instead.
     */
    getPreviewElement?: () => HTMLElement | null;
    /** Flips when preview is toggled, so the search re-runs against the new target. */
    previewActive?: boolean;
}

interface MatchState {
    total: number;
    current: number;
}

const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?_';

export function FindReplaceBar({
    isOpen,
    showReplace,
    onClose,
    getEditor,
    getPreviewElement,
    previewActive = false,
}: FindReplaceBarProps) {
    const [search, setSearch] = useState('');
    const [replace, setReplace] = useState('');
    const [matchCase, setMatchCase] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [replaceVisible, setReplaceVisible] = useState(showReplace);
    const [matches, setMatches] = useState<MatchState>({ total: 0, current: 0 });
    const searchRef = useRef<HTMLInputElement>(null);
    const decorationsRef = useRef<string[]>([]);
    const decoratedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const decoratedModelRef = useRef<editor.ITextModel | null>(null);
    const matchRangesRef = useRef<editor.FindMatch[]>([]);
    const currentIdxRef = useRef(0);
    // Preview-mode search state: the body we highlighted into, and the marks we
    // put there. Kept separate from the Monaco decoration refs above so toggling
    // preview can tear down exactly one of the two.
    const previewRootRef = useRef<HTMLElement | null>(null);
    const previewMarksRef = useRef<HTMLElement[]>([]);
    const suspendObserverRef = useRef(false);
    const [inPreview, setInPreview] = useState(false);

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
            return;
        }
        // Preview mode: seed from whatever the user highlighted in the rendered
        // output, matching the editor-mode behaviour above.
        const root = getPreviewElement?.();
        const domSel = root ? window.getSelection() : null;
        if (root && domSel && !domSel.isCollapsed && root.contains(domSel.anchorNode)) {
            const text = domSel.toString();
            if (text && !text.includes('\n')) setSearch(text);
        }
    }, [isOpen, getEditor, getPreviewElement]);

    // Clear decorations helper
    const clearDeco = useCallback(() => {
        const model = decoratedModelRef.current;
        if (model && !model.isDisposed() && decorationsRef.current.length > 0) {
            decorationsRef.current = model.deltaDecorations(decorationsRef.current, []);
        } else {
            decorationsRef.current = [];
        }
        decoratedEditorRef.current = null;
        decoratedModelRef.current = null;
        matchRangesRef.current = [];
    }, []);

    // Tear down preview highlights (mirror of clearDeco for the DOM path).
    const clearPreview = useCallback(() => {
        const root = previewRootRef.current;
        if (root) {
            suspendObserverRef.current = true;
            clearPreviewHighlights(root);
            setTimeout(() => { suspendObserverRef.current = false; }, 0);
        }
        previewRootRef.current = null;
        previewMarksRef.current = [];
    }, []);

    // Core search function
    const doSearch = useCallback((resetIndex = false) => {
        const ed = getEditor();
        // Monaco is unmounted while previewing, so fall back to the rendered DOM
        // rather than bailing out and reporting a false "0 of 0". A disposed
        // editor reports a null model, so check that too — otherwise a stale
        // instance held after unmount would shadow the preview path entirely.
        const hasLiveEditor = !!ed?.getModel();
        const previewRoot = hasLiveEditor ? null : (getPreviewElement?.() ?? null);

        if (previewRoot) {
            setInPreview(true);
            clearDeco(); // drop editor decorations left over from source mode
            if (previewRootRef.current && previewRootRef.current !== previewRoot) {
                clearPreviewHighlights(previewRootRef.current);
            }
            previewRootRef.current = previewRoot;

            // Suspend the re-render observer: the wrapping below is our own
            // mutation and must not retrigger the search.
            suspendObserverRef.current = true;
            const marks = search
                ? highlightPreviewMatches(previewRoot, search, { matchCase, wholeWord, useRegex })
                : (clearPreviewHighlights(previewRoot), []);
            setTimeout(() => { suspendObserverRef.current = false; }, 0);

            previewMarksRef.current = marks;
            if (resetIndex) currentIdxRef.current = 0;
            const idx = marks.length > 0 ? Math.min(currentIdxRef.current, marks.length - 1) : 0;
            currentIdxRef.current = idx;

            if (marks.length > 0) {
                setCurrentPreviewMatch(marks, idx);
                setMatches({ total: marks.length, current: idx + 1 });
            } else {
                setMatches({ total: 0, current: 0 });
            }
            return;
        }

        setInPreview(false);
        clearPreview(); // leaving preview — remove its marks before editor search
        if (!ed) return;
        const model = ed.getModel();
        if (
            (decoratedEditorRef.current && decoratedEditorRef.current !== ed) ||
            (decoratedModelRef.current && decoratedModelRef.current !== model)
        ) {
            clearDeco();
        }
        decoratedEditorRef.current = ed;
        decoratedModelRef.current = model;
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
            decorationsRef.current = model.deltaDecorations(decorationsRef.current, decos);

            if (found.length > 0) {
                ed.setSelection(found[idx].range);
                // Immediate, not the default Smooth: an animated reveal fires several
                // intermediate onDidScrollChange events, each of which round-trips through
                // React state and back into EditorPanel's scroll-sync effect, which calls
                // setScrollPosition() with that mid-animation value — snapping the viewport
                // back before the animation finishes centering on the match.
                ed.revealRangeInCenter(found[idx].range, editor.ScrollType.Immediate);
                setMatches({ total: found.length, current: idx + 1 });
            } else {
                setMatches({ total: 0, current: 0 });
            }
        } catch {
            // Invalid regex — show no results
            clearDeco();
            setMatches({ total: 0, current: 0 });
        }
    }, [search, matchCase, wholeWord, useRegex, getEditor, getPreviewElement, clearDeco, clearPreview]);

    // Re-run search when the query, the options, or the target (editor vs
    // preview) changes. previewActive is in the deps so toggling preview while
    // the bar is open re-points the search instead of leaving it stale.
    useEffect(() => {
        if (isOpen) doSearch(true);
    }, [search, matchCase, wholeWord, useRegex, isOpen, previewActive, doSearch]);

    // The preview renders its HTML asynchronously (marked.parse is awaited), so
    // the body can still be empty when the bar first searches it. Re-run once the
    // real content lands — and on any later re-render.
    useEffect(() => {
        if (!isOpen || !previewActive) return;
        const root = getPreviewElement?.();
        if (!root) return;
        const observer = new MutationObserver(() => {
            if (suspendObserverRef.current) return; // our own <mark> wrapping
            previewMarksRef.current = [];
            doSearch(true);
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        return () => observer.disconnect();
    }, [isOpen, previewActive, getPreviewElement, doSearch]);

    // Monaco can keep the editor instance while swapping its model. Clear IDs
    // against the old model and immediately rebuild matches for the new one.
    useEffect(() => {
        if (!isOpen || previewActive) return;
        const ed = getEditor();
        if (!ed?.getModel()) return;
        const subscription = ed.onDidChangeModel(() => {
            clearDeco();
            doSearch(true);
        });
        return () => subscription.dispose();
    }, [isOpen, previewActive, getEditor, clearDeco, doSearch]);

    useEffect(() => () => { clearDeco(); clearPreview(); }, [clearDeco, clearPreview]);

    // Navigate matches
    const navigate = useCallback((dir: 1 | -1) => {
        const previewMarks = previewRootRef.current ? previewMarksRef.current : null;
        const total = previewMarks ? previewMarks.length : matchRangesRef.current.length;
        if (total === 0) return;
        let idx = currentIdxRef.current + dir;
        if (idx >= total) idx = 0;
        if (idx < 0) idx = total - 1;
        currentIdxRef.current = idx;
        if (previewMarks) {
            // Marks are already in the DOM — just move the "current" styling and
            // scroll, instead of re-wrapping the whole document on every step.
            setCurrentPreviewMatch(previewMarks, idx);
            setMatches({ total, current: idx + 1 });
            return;
        }
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
        clearPreview();
        setSearch('');
        onClose();
        getEditor()?.focus();
    }, [clearDeco, clearPreview, onClose, getEditor]);

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
            {/* Replace can't act on rendered output, so the toggle is inert while
                previewing — Ctrl+H drops back to the editor instead. */}
            <button
                className={`fr-toggle-btn ${replaceVisible && !inPreview ? 'open' : ''}`}
                onClick={() => setReplaceVisible(v => !v)}
                title={inPreview ? 'Replace is unavailable in Markdown preview' : replaceVisible ? 'Hide Replace' : 'Show Replace'}
                disabled={inPreview}
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
                {replaceVisible && !inPreview && (
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
