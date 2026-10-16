import { useState, useEffect, useRef, useCallback } from 'react';
import { editor } from 'monaco-editor';
import {
    clearPreviewHighlights,
    highlightPreviewMatches,
    setCurrentPreviewMatch,
} from '../utils/previewSearch';
import { readToken } from '../utils/theme';
import { expandReplacement } from '../utils/replacePattern';
import { isImeComposing } from '../utils/shortcuts';
import { checkRegexSpeed, regexGuardAvailable } from '../utils/heavyTasks';
import { addMark, markProblem, setLastFindQuery } from '../utils/marks';

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

// Monaco's default word separators: "_" is part of a word, so whole-word
// "user" does not match inside "user_id" (and Replace All cannot corrupt
// identifiers). Matches Find in Files, which also treats "_" as a word char.
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

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

    // Regular expressions are first run once in a background worker with a
    // time limit: a pattern such as (a+)+$ can otherwise freeze
    // the whole window. Verdicts are kept per pattern and document.
    const regexVerdicts = useRef(new Map<string, 'checking' | 'ok' | 'slow'>());
    const [regexTooSlow, setRegexTooSlow] = useState(false);
    const [markProblemText, setMarkProblem] = useState<string | null>(null);
    useEffect(() => { setMarkProblem(null); }, [search, useRegex]);

    // "Mark Find Matches" in the command palette marks what is searched here.
    useEffect(() => {
        setLastFindQuery(regexTooSlow ? null : { text: search, regex: useRegex, caseSensitive: matchCase, wholeWord });
    }, [search, useRegex, matchCase, wholeWord, regexTooSlow]);

    /** Keeps every match highlighted (a persistent mark) after Find closes. */
    const markAll = async () => {
        const model = getEditor()?.getModel();
        if (!model || !search || regexTooSlow) return;
        const query = { text: search, regex: useRegex, caseSensitive: matchCase, wholeWord };
        const problem = markProblem(query);
        if (problem) {
            setMarkProblem(problem);
            return;
        }
        setMarkProblem(null);
        // A mark re-runs its pattern as the document changes, so a regular
        // expression must be known to be fast first (the search's own check
        // may still be running).
        if (useRegex && regexGuardAvailable()
            && await checkRegexSpeed(search, matchCase ? 'gm' : 'gim', model.getValue()) === 'slow') {
            setRegexTooSlow(true);
            return;
        }
        if (!model.isDisposed()) await addMark(model, query);
    };
    const doSearchRef = useRef<(resetIndex?: boolean, moveSelection?: boolean) => void>(() => {});
    /** True when the search may run on `scope` now; otherwise starts the check. */
    const regexReady = useCallback((scope: string, getText: () => string): boolean => {
        if (!useRegex || !search || !regexGuardAvailable()) {
            setRegexTooSlow(false);
            return true;
        }
        const key = `${scope}\u0000${matchCase}\u0000${search}`;
        const verdict = regexVerdicts.current.get(key);
        setRegexTooSlow(verdict === 'slow');
        if (verdict === 'ok') return true;
        if (verdict === undefined) {
            regexVerdicts.current.set(key, 'checking');
            void checkRegexSpeed(search, matchCase ? 'gm' : 'gim', getText()).then(result => {
                regexVerdicts.current.set(key, result);
                doSearchRef.current(true, true);
            });
        }
        return false;
    }, [useRegex, search, matchCase]);

    // Core search function
    // `moveSelection` false only refreshes counts and highlights (used when the
    // document changes underneath an open bar, so typing is never interrupted).
    const doSearch = useCallback((resetIndex = false, moveSelection = true) => {
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
            const marks = search && regexReady('preview', () => previewRoot.textContent ?? '')
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
        if (!model || !search || !regexReady(model.uri.toString(), () => model.getValue())) {
            clearDeco();
            matchRangesRef.current = [];
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
                        // Monaco wants a colour string here, so the token is read
                        // rather than referenced. Re-read on every search, which is
                        // also when a theme change would need it.
                        color: readToken('--match-ruler', '#f2a63b'),
                        position: 4 as unknown as editor.OverviewRulerLane,
                    },
                },
            }));
            decorationsRef.current = model.deltaDecorations(decorationsRef.current, decos);

            if (found.length > 0 && !moveSelection) {
                setMatches({ total: found.length, current: idx + 1 });
            } else if (found.length > 0) {
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
    }, [search, matchCase, wholeWord, useRegex, getEditor, getPreviewElement, clearDeco, clearPreview, regexReady]);
    doSearchRef.current = doSearch;

    // Re-run search when the query, the options, or the target (editor vs
    // preview) changes. previewActive is in the deps so toggling preview while
    // the bar is open re-points the search instead of leaving it stale.
    useEffect(() => {
        if (isOpen) doSearch(true);
    }, [search, matchCase, wholeWord, useRegex, isOpen, previewActive, doSearch]);

    // The preview renders its HTML asynchronously (marked.parse is awaited), so
    // the body can still be empty when the bar first searches it. Re-run once the
    // real content lands — and on any later re-render.
    // The preview itself also loads on first use (LazyMarkdownPreview), so its
    // body may not exist yet: wait for it briefly, then search it.
    useEffect(() => {
        if (!isOpen || !previewActive) return;
        let observer: MutationObserver | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let tries = 0;
        const attach = () => {
            const root = getPreviewElement?.();
            if (!root) {
                if (tries++ < 100) timer = setTimeout(attach, 50);
                return;
            }
            observer = new MutationObserver(() => {
                if (suspendObserverRef.current) return; // our own <mark> wrapping
                previewMarksRef.current = [];
                doSearch(true);
            });
            observer.observe(root, { childList: true, subtree: true, characterData: true });
            if (tries > 0) doSearch(true); // it arrived after the first search
        };
        attach();
        return () => {
            if (timer !== undefined) clearTimeout(timer);
            observer?.disconnect();
        };
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

    // Keep matches in step with the document. Cached ranges went stale after
    // any edit (typing, paste, undo, formatting), and Replace then edited
    // whatever text had moved into the old range. Refreshing here never moves
    // the selection, so typing in the editor is not interrupted.
    useEffect(() => {
        if (!isOpen || previewActive) return;
        const ed = getEditor();
        if (!ed?.getModel()) return;
        let timer: number | undefined;
        const subscription = ed.onDidChangeModelContent(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => doSearch(false, false), 30);
        });
        return () => { window.clearTimeout(timer); subscription.dispose(); };
    }, [isOpen, previewActive, getEditor, doSearch]);

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

    // Matches computed against the document as it is right now. Replace never
    // trusts cached ranges, which may predate the latest edit.
    const findCurrentMatches = useCallback((model: editor.ITextModel): editor.FindMatch[] | null => {
        if (!search || !regexReady(model.uri.toString(), () => model.getValue())) return null;
        try {
            return model.findMatches(search, true, useRegex, matchCase, wholeWord ? WORD_SEPARATORS : null, true);
        } catch {
            return null; // invalid regex
        }
    }, [search, useRegex, matchCase, wholeWord, regexReady]);

    const handleReplace = useCallback(() => {
        const ed = getEditor();
        const model = ed?.getModel();
        if (!ed || !model) return;
        const found = findCurrentMatches(model);
        if (!found || found.length === 0) {
            doSearch();
            return;
        }
        // Like VS Code: replace only when the selection is exactly a match;
        // otherwise this press selects the next match first.
        const selection = ed.getSelection();
        const target = selection ? found.find(match => match.range.equalsRange(selection)) : undefined;
        if (!target) {
            const from = selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
            const next = found.findIndex(match => model.getOffsetAt(match.range.getStartPosition()) >= from);
            currentIdxRef.current = next === -1 ? 0 : next;
            doSearch();
            return;
        }
        const text = expandReplacement(replace, target.matches, useRegex);
        const insertedEnd = model.getOffsetAt(target.range.getStartPosition()) + text.length;
        ed.pushUndoStop();
        ed.executeEdits('find-replace', [{ range: target.range, text, forceMoveMarkers: true }]);
        ed.pushUndoStop();
        // Continue with the first match after the inserted text, so a
        // replacement that itself matches is not replaced again.
        const after = findCurrentMatches(model) ?? [];
        const next = after.findIndex(match => model.getOffsetAt(match.range.getStartPosition()) >= insertedEnd);
        currentIdxRef.current = next === -1 ? 0 : next;
        doSearch();
    }, [replace, useRegex, getEditor, doSearch, findCurrentMatches]);

    const handleReplaceAll = useCallback(() => {
        const ed = getEditor();
        const model = ed?.getModel();
        if (!ed || !model) return;
        const found = findCurrentMatches(model);
        if (!found || found.length === 0) return;
        const edits = [...found].reverse().map(match => ({
            range: match.range,
            text: expandReplacement(replace, match.matches, useRegex),
        }));
        // One undo step for the whole Replace All.
        ed.pushUndoStop();
        ed.executeEdits('find-replace-all', edits);
        ed.pushUndoStop();
        currentIdxRef.current = 0;
        doSearch(true);
    }, [replace, useRegex, getEditor, doSearch, findCurrentMatches]);

    const handleClose = useCallback(() => {
        clearDeco();
        clearPreview();
        setSearch('');
        onClose();
        getEditor()?.focus();
    }, [clearDeco, clearPreview, onClose, getEditor]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (isImeComposing(e)) return; // Enter commits the IME composition
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
                previewing — the Replace shortcut drops back to the editor instead. */}
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

                    <span
                        className={`fr-count ${noResults || markProblemText ? 'no-match' : ''}`}
                        title={markProblemText ?? (regexTooSlow ? 'This regular expression takes too long on this document, so it was not run.' : undefined)}
                        role={markProblemText ? 'alert' : undefined}
                    >
                        {markProblemText ? "Can't mark" : regexTooSlow ? 'Too slow' : search ? `${matches.current} of ${matches.total}` : ''}
                    </span>

                    <div className="fr-actions">
                        <button className="fr-btn" onClick={() => navigate(-1)} title="Previous (Shift+Enter)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                        </button>
                        <button className="fr-btn fr-btn-default" onClick={() => navigate(1)} title="Next (Enter)">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                        <button className="fr-btn fr-btn-text" onClick={() => { void markAll(); }} disabled={!search || inPreview || regexTooSlow}
                            title="Keep every match highlighted in its own colour (a mark), after Find closes">
                            Mark
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
                                onKeyDown={(e) => {
                                    if (isImeComposing(e)) return;
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        // Handled here: letting it bubble to the bar's
                                        // handler also moved to the next match, so every
                                        // other match was skipped.
                                        e.stopPropagation();
                                        handleReplace();
                                    }
                                }}
                                spellCheck={false}
                            />
                        </div>
                        <div className="fr-actions">
                            <button className="fr-btn fr-btn-text" onClick={handleReplace} title="Replace">
                                Replace
                            </button>
                            <button className="fr-btn fr-btn-text" onClick={handleReplaceAll} title="Replace All">
                                All
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
