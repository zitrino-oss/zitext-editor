/**
 * File Compare. Two editors, side by side (or one, inline), showing what
 * differs between two documents: added, removed and changed lines, with the
 * changed characters marked. Changes can be copied from either side to the
 * other, one at a time.
 *
 * An open document is compared through its own editor model, so edits made
 * here are ordinary edits to that tab (undo, dirty marker, autosave, Save).
 * Clipboard text and the saved version on disk are read-only snapshots.
 *
 * The diff is ZITEXT's own (utils/textDiff) rather than Monaco's diff
 * editor, which can only ignore leading/trailing whitespace; here case and
 * blank lines can be ignored too.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { editor, IDisposable } from 'monaco-editor';
import monaco from '../monaco-config';
import { getModelForTab, modelUriForTab } from '../utils/editorModels';
import { computeDiff, DEFAULT_DIFF_OPTIONS, mergeEdit, type DiffOptions, type DiffRegion, type DiffResult } from '../utils/textDiff';
import { alignmentZones, anchorLine, changeAtOrAfter, changeSummary } from '../utils/compareLayout';
import { HeavyTaskAborted, runHeavyTaskOffThread } from '../utils/heavyTasks';
import type { ViewCommands } from '../utils/workspaceViews';
import { addClipboardActions } from '../utils/clipboardActions';

export type ResolvedSide =
    | { kind: 'tab'; tabId: string; title: string; content: string; language: string; readOnly: boolean; isDirty: boolean }
    | { kind: 'snapshot'; label: string; text: string; language: string };

interface CompareViewProps {
    viewId: string;
    left: ResolvedSide;
    right: ResolvedSide;
    visible: boolean;
    editorTheme: string;
    fontFamily: string;
    fontSize: number;
    onTabEdited: (tabId: string, content: string) => void;
    onSaveTab: (tabId: string) => void;
    onSwap: () => void;
    onRegisterCommands: (commands: ViewCommands | null) => void;
}

/** Inputs with more lines than this are compared in the background worker. */
const WORKER_THRESHOLD_LINES = 3000;
const RECOMPUTE_DELAY_MS = 250;

type Side = 'left' | 'right';

function sideTitle(side: ResolvedSide): string {
    return side.kind === 'tab' ? side.title : side.label;
}

function sideReadOnly(side: ResolvedSide): boolean {
    return side.kind === 'snapshot' || side.readOnly;
}

/** The side's model: the tab's own model (created if the tab hasn't been
 *  shown in an editor yet), or a private one for a snapshot. */
function acquireModel(viewId: string, which: Side, side: ResolvedSide): { model: editor.ITextModel; owned: boolean } {
    if (side.kind === 'tab') {
        const existing = getModelForTab(side.tabId);
        if (existing && !existing.isDisposed()) return { model: existing, owned: false };
        const model = monaco.editor.createModel(side.content, side.language, monaco.Uri.parse(modelUriForTab(side.tabId)));
        return { model, owned: false };
    }
    const uri = monaco.Uri.parse(`inmemory://compare/${viewId}/${which}`);
    monaco.editor.getModel(uri)?.dispose();
    return { model: monaco.editor.createModel(side.text, side.language, uri), owned: true };
}

export function CompareView({
    viewId, left, right, visible, editorTheme, fontFamily, fontSize,
    onTabEdited, onSaveTab, onSwap, onRegisterCommands,
}: CompareViewProps) {
    const [options, setOptions] = useState<DiffOptions>(DEFAULT_DIFF_OPTIONS);
    const [inline, setInline] = useState(false);
    // The diff and the modelVersion it was computed for. Changes are only
    // drawn as mergeable while it is current (see diffIsCurrent).
    const [computed, setComputed] = useState<{ result: DiffResult; version: number } | null>(null);
    const result = computed?.result ?? null;
    const [current, setCurrent] = useState(-1);
    const [computing, setComputing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [modelVersion, setModelVersion] = useState(0);
    /** Bumped when the editors are (re)created, so their decorations are built. */
    const [editorsVersion, setEditorsVersion] = useState(0);

    const leftHost = useRef<HTMLDivElement>(null);
    const lastFocused = useRef<editor.IStandaloneCodeEditor | null>(null);
    const rightHost = useRef<HTMLDivElement>(null);
    const editors = useRef<{ left: editor.IStandaloneCodeEditor | null; right: editor.IStandaloneCodeEditor | null }>({ left: null, right: null });
    const models = useRef<{ left: editor.ITextModel | null; right: editor.ITextModel | null }>({ left: null, right: null });
    const leftReadOnly = sideReadOnly(left);
    const rightReadOnly = sideReadOnly(right);

    const changes = useMemo(() => result?.regions.filter(region => !region.ignored) ?? [], [result]);
    const fresh = computed !== null && computed.version === modelVersion;

    // The exact texts the current diff describes. A merge applies line ranges
    // from the diff, so it is refused unless both documents are still exactly
    // those texts: a second click before the diff catches up (or after Swap)
    // would otherwise copy the wrong lines. Checked synchronously, because
    // two clicks can arrive before React renders again.
    const diffSource = useRef<{ left: editor.ITextModel; right: editor.ITextModel; leftVersion: number; rightVersion: number } | null>(null);
    const recomputeNow = useRef(false);
    const diffIsCurrent = () => {
        const source = diffSource.current;
        const { left: leftModel, right: rightModel } = models.current;
        return !!source && !!leftModel && !!rightModel
            && source.left === leftModel && source.right === rightModel
            && source.leftVersion === leftModel.getVersionId() && source.rightVersion === rightModel.getVersionId();
    };

    // Stable identity of each side: a different tab or snapshot rebuilds the models.
    const leftKey = left.kind === 'tab' ? `tab:${left.tabId}` : `snap:${left.label}:${left.text.length}`;
    const rightKey = right.kind === 'tab' ? `tab:${right.tabId}` : `snap:${right.label}:${right.text.length}`;
    const sidesRef = useRef({ left, right });
    sidesRef.current = { left, right };
    const onTabEditedRef = useRef(onTabEdited);
    onTabEditedRef.current = onTabEdited;

    // ─── Models ─────────────────────────────────────────────────────────
    useEffect(() => {
        const acquired = {
            left: acquireModel(viewId, 'left', sidesRef.current.left),
            right: acquireModel(viewId, 'right', sidesRef.current.right),
        };
        models.current = { left: acquired.left.model, right: acquired.right.model };
        const subscriptions: IDisposable[] = (['left', 'right'] as const).map(which =>
            acquired[which].model.onDidChangeContent(() => {
                const side = sidesRef.current[which];
                if (side.kind === 'tab') {
                    // Only an edit made here is reported. Text the app put in
                    // the model (Reload, Revert, the sync below, an editor
                    // showing the same tab) already is the tab's content;
                    // reporting it again would mark a reverted tab unsaved.
                    const value = acquired[which].model.getValue();
                    if (value !== side.content) onTabEditedRef.current(side.tabId, value);
                }
                setModelVersion(v => v + 1);
            }));
        setModelVersion(v => v + 1);
        return () => {
            subscriptions.forEach(s => s.dispose());
            models.current = { left: null, right: null };
            // Only snapshot models belong to the view; a tab's model stays
            // with its tab.
            for (const which of ['left', 'right'] as const) {
                if (acquired[which].owned) acquired[which].model.dispose();
            }
        };
    }, [viewId, leftKey, rightKey]);

    // A tab's text changed elsewhere (Reload, Revert): bring its model up to
    // date. Only a change of the tab's own content counts, so a render that
    // still carries the text from before an edit made here can never undo it.
    const seenContent = useRef<{ left?: string; right?: string }>({});
    useEffect(() => {
        for (const which of ['left', 'right'] as const) {
            const side = which === 'left' ? left : right;
            const model = models.current[which];
            if (side.kind !== 'tab' || !model || model.isDisposed()) continue;
            const previous = seenContent.current[which];
            seenContent.current[which] = side.content;
            if (previous === undefined || previous === side.content) continue;
            if (model.getValue() !== side.content) {
                model.pushEditOperations([], [{ range: model.getFullModelRange(), text: side.content }], () => null);
            }
        }
    }, [left, right]);

    // ─── Editors ────────────────────────────────────────────────────────
    useEffect(() => {
        monaco.editor.setTheme(editorTheme);
    }, [editorTheme]);

    useEffect(() => {
        const leftModel = models.current.left;
        const rightModel = models.current.right;
        if (!rightHost.current || !leftModel || !rightModel) return;
        const common: editor.IStandaloneEditorConstructionOptions = {
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off', // filler alignment needs one row per line
            glyphMargin: true,
            fontFamily,
            fontSize,
            renderLineHighlight: 'none',
            folding: false,
            overviewRulerLanes: 2,
        };
        const rightEditor = monaco.editor.create(rightHost.current, { ...common, model: rightModel, readOnly: rightReadOnly });
        const leftEditor = !inline && leftHost.current
            ? monaco.editor.create(leftHost.current, { ...common, model: leftModel, readOnly: leftReadOnly })
            : null;
        editors.current = { left: leftEditor, right: rightEditor };
        lastFocused.current = rightEditor;
        setEditorsVersion(v => v + 1);

        // The clipboard items every ZITEXT editor has (monaco-config removes
        // Monaco's own, which WebView2 blocks), and which editor the Edit menu
        // acts on.
        const focusSubscriptions: IDisposable[] = [];
        for (const target of [leftEditor, rightEditor]) {
            if (!target) continue;
            addClipboardActions(target);
            focusSubscriptions.push(target.onDidFocusEditorText(() => { lastFocused.current = target; }));
        }

        // Side by side, the two editors scroll together.
        let syncing = false;
        const follow = (from: editor.IStandaloneCodeEditor, to: editor.IStandaloneCodeEditor) =>
            from.onDidScrollChange(event => {
                if (syncing || (!event.scrollTopChanged && !event.scrollLeftChanged)) return;
                syncing = true;
                to.setScrollPosition({ scrollTop: event.scrollTop, scrollLeft: event.scrollLeft });
                syncing = false;
            });
        const subscriptions = leftEditor ? [follow(leftEditor, rightEditor), follow(rightEditor, leftEditor)] : [];
        setModelVersion(v => v + 1);
        return () => {
            subscriptions.forEach(s => s.dispose());
            focusSubscriptions.forEach(s => s.dispose());
            lastFocused.current = null;
            leftEditor?.dispose();
            rightEditor.dispose();
            editors.current = { left: null, right: null };
        };
        // Font and read-only changes are applied below without rebuilding.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inline, viewId, leftKey, rightKey]);

    useEffect(() => {
        editors.current.left?.updateOptions({ fontFamily, fontSize, readOnly: leftReadOnly });
        editors.current.right?.updateOptions({ fontFamily, fontSize, readOnly: rightReadOnly });
    }, [fontFamily, fontSize, leftReadOnly, rightReadOnly]);

    useEffect(() => {
        if (!visible) return;
        editors.current.left?.layout();
        editors.current.right?.layout();
    }, [visible]);

    // ─── Diff ───────────────────────────────────────────────────────────
    useEffect(() => {
        const leftModel = models.current.left;
        const rightModel = models.current.right;
        if (!leftModel || !rightModel) return;
        let cancelled = false;
        const abort = new AbortController();
        const version = modelVersion;
        const delay = result === null || recomputeNow.current ? 0 : RECOMPUTE_DELAY_MS;
        recomputeNow.current = false;
        const timer = window.setTimeout(async () => {
            const source = { left: leftModel, right: rightModel, leftVersion: leftModel.getVersionId(), rightVersion: rightModel.getVersionId() };
            const leftLines = leftModel.getLinesContent();
            const rightLines = rightModel.getLinesContent();
            setComputing(true);
            try {
                const next = leftLines.length + rightLines.length > WORKER_THRESHOLD_LINES
                    ? JSON.parse(await runHeavyTaskOffThread({ kind: 'diff', left: leftLines, right: rightLines, options }, undefined, abort.signal)) as DiffResult
                    : computeDiff(leftLines, rightLines, options);
                if (cancelled) return;
                diffSource.current = source;
                setComputed({ result: next, version });
                setError(null);
            } catch (err) {
                if (!cancelled && !(err instanceof HeavyTaskAborted)) setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setComputing(false);
            }
        }, delay);
        return () => { cancelled = true; window.clearTimeout(timer); abort.abort(); };
        // Recomputed when either text or the options change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [modelVersion, options]);

    // Keep the current change in range as the diff changes.
    useEffect(() => {
        setCurrent(index => (index >= changes.length ? changes.length - 1 : index));
    }, [changes.length]);

    // ─── Decorations and filler ─────────────────────────────────────────
    useEffect(() => {
        const leftEditor = editors.current.left;
        const rightEditor = editors.current.right;
        if (!rightEditor || !result) return;
        const added: editor.IModelDeltaDecoration[] = [];
        const removed: editor.IModelDeltaDecoration[] = [];
        const lineDecoration = (className: string, ruler: string): editor.IModelDecorationOptions => ({
            isWholeLine: true,
            className,
            overviewRuler: { color: ruler, position: monaco.editor.OverviewRulerLane.Full },
        });
        const addedRuler = 'rgba(46, 168, 119, 0.7)';
        const removedRuler = 'rgba(220, 76, 76, 0.7)';
        changes.forEach((change, index) => {
            const isCurrent = index === current;
            for (let line = change.rightStart; line < change.rightStart + change.rightCount; line++) {
                added.push({ range: new monaco.Range(line, 1, line, 1), options: lineDecoration(`diff-line-added${isCurrent ? ' diff-current' : ''}`, addedRuler) });
            }
            for (let line = change.leftStart; line < change.leftStart + change.leftCount; line++) {
                removed.push({ range: new monaco.Range(line, 1, line, 1), options: lineDecoration(`diff-line-removed${isCurrent ? ' diff-current' : ''}`, removedRuler) });
            }
            for (const pair of change.lines) {
                for (const range of pair.right) added.push({ range: new monaco.Range(pair.rightLine, range.startColumn, pair.rightLine, range.endColumn), options: { inlineClassName: 'diff-char-added' } });
                for (const range of pair.left) removed.push({ range: new monaco.Range(pair.leftLine, range.startColumn, pair.leftLine, range.endColumn), options: { inlineClassName: 'diff-char-removed' } });
            }
            // Merge arrows: copy this change into the other side, unless that
            // side can't be edited.
            if (!leftReadOnly && leftEditor) {
                added.push({
                    range: new monaco.Range(anchorLine(change, 'right'), 1, anchorLine(change, 'right'), 1),
                    options: { glyphMarginClassName: 'diff-glyph diff-glyph-to-left', glyphMarginHoverMessage: { value: 'Copy this change to the left' } },
                });
            }
            if (!rightReadOnly) {
                const glyph = { glyphMarginClassName: `diff-glyph ${inline ? 'diff-glyph-revert' : 'diff-glyph-to-right'}`, glyphMarginHoverMessage: { value: inline ? 'Undo this change (use the left version)' : 'Copy this change to the right' } };
                if (leftEditor) {
                    removed.push({ range: new monaco.Range(anchorLine(change, 'left'), 1, anchorLine(change, 'left'), 1), options: glyph });
                } else {
                    added.push({ range: new monaco.Range(anchorLine(change, 'right'), 1, anchorLine(change, 'right'), 1), options: glyph });
                }
            }
        });
        const rightIds = rightEditor.createDecorationsCollection(added);
        const leftIds = leftEditor?.createDecorationsCollection(removed);

        // Filler (side by side) or the removed lines drawn above each change
        // (inline).
        const zoneIds: { editor: editor.IStandaloneCodeEditor; id: string }[] = [];
        const fontInfo = rightEditor.getOption(monaco.editor.EditorOption.fontInfo);
        if (leftEditor) {
            const zones = alignmentZones(result.regions);
            const add = (target: editor.IStandaloneCodeEditor, list: typeof zones.left) => target.changeViewZones(accessor => {
                for (const zone of list) {
                    const domNode = document.createElement('div');
                    domNode.className = 'diff-filler';
                    zoneIds.push({ editor: target, id: accessor.addZone({ afterLineNumber: zone.afterLineNumber, heightInLines: zone.heightInLines, domNode }) });
                }
            });
            add(leftEditor, zones.left);
            add(rightEditor, zones.right);
        } else {
            const leftModel = models.current.left;
            rightEditor.changeViewZones(accessor => {
                for (const change of changes) {
                    if (change.leftCount === 0 || !leftModel) continue;
                    const domNode = document.createElement('div');
                    domNode.className = 'diff-inline-removed';
                    domNode.style.fontFamily = fontInfo.fontFamily;
                    domNode.style.fontSize = `${fontInfo.fontSize}px`;
                    domNode.style.lineHeight = `${fontInfo.lineHeight}px`;
                    for (let line = change.leftStart; line < change.leftStart + change.leftCount; line++) {
                        const row = document.createElement('div');
                        row.className = 'diff-inline-removed-line';
                        const text = line <= leftModel.getLineCount() ? leftModel.getLineContent(line) : '';
                        const ranges = change.lines.find(pair => pair.leftLine === line)?.left ?? [];
                        let column = 1;
                        for (const range of ranges) {
                            row.append(text.slice(column - 1, range.startColumn - 1));
                            const mark = document.createElement('span');
                            mark.className = 'diff-char-removed';
                            mark.textContent = text.slice(range.startColumn - 1, range.endColumn - 1);
                            row.append(mark);
                            column = range.endColumn;
                        }
                        row.append(text.slice(column - 1) || '​');
                        domNode.append(row);
                    }
                    zoneIds.push({ editor: rightEditor, id: accessor.addZone({ afterLineNumber: change.rightStart - 1, heightInLines: change.leftCount, domNode }) });
                }
            });
        }
        return () => {
            // The editors may already be disposed (view switched to inline,
            // or closed); there is then nothing left to clean up.
            try {
                rightIds.clear();
                leftIds?.clear();
                for (const target of [leftEditor, rightEditor]) {
                    if (!target || target.getModel() === null) continue;
                    target.changeViewZones(accessor => {
                        for (const zone of zoneIds) if (zone.editor === target) accessor.removeZone(zone.id);
                    });
                }
            } catch {
                /* disposed */
            }
        };
        // Rebuilt for a new diff, new editors or a new font, not on every
        // keystroke: decorations follow edits by themselves until the next
        // diff, and a merge from a diff that is behind is refused anyway.
    }, [result, changes, current, inline, leftReadOnly, rightReadOnly, editorsVersion, fontFamily, fontSize]);

    // ─── Merge ──────────────────────────────────────────────────────────
    const copyChange = useCallback((change: DiffRegion, from: Side) => {
        const target: Side = from === 'left' ? 'right' : 'left';
        const leftModel = models.current.left;
        const rightModel = models.current.right;
        const targetModel = models.current[target];
        if (!leftModel || !rightModel || !targetModel) return;
        if (target === 'left' ? leftReadOnly : rightReadOnly) return;
        if (!diffIsCurrent()) return;
        recomputeNow.current = true;
        const edit = mergeEdit(change, from, leftModel.getLinesContent(), rightModel.getLinesContent(), targetModel.getEOL());
        const targetEditor = editors.current[target];
        const range = new monaco.Range(edit.startLineNumber, edit.startColumn, edit.endLineNumber, edit.endColumn);
        if (targetEditor) {
            targetEditor.pushUndoStop();
            targetEditor.executeEdits('compare-merge', [{ range, text: edit.text, forceMoveMarkers: true }]);
            targetEditor.pushUndoStop();
        } else {
            targetModel.pushEditOperations([], [{ range, text: edit.text, forceMoveMarkers: true }], () => null);
        }
    }, [leftReadOnly, rightReadOnly]);

    // Clicks on the merge arrows in the glyph margin.
    useEffect(() => {
        const handlers: IDisposable[] = [];
        for (const which of ['left', 'right'] as const) {
            const target = editors.current[which];
            if (!target) continue;
            handlers.push(target.onMouseDown(event => {
                if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
                const line = event.target.position?.lineNumber;
                const element = event.target.element;
                if (!line || !element?.className.includes('diff-glyph')) return;
                const change = changes.find(c => anchorLine(c, which) === line);
                if (!change) return;
                // On the right in inline view, the arrow undoes the change.
                const from: Side = element.className.includes('diff-glyph-to-left') ? 'right' : 'left';
                copyChange(change, from);
            }));
        }
        return () => handlers.forEach(h => h.dispose());
    }, [changes, copyChange, inline, editorsVersion]);

    // ─── Navigation ─────────────────────────────────────────────────────
    const reveal = useCallback((index: number) => {
        const change = changes[index];
        if (!change) return;
        setCurrent(index);
        const rightEditor = editors.current.right;
        const leftEditor = editors.current.left;
        rightEditor?.revealLineInCenter(anchorLine(change, 'right'));
        rightEditor?.setPosition({ lineNumber: anchorLine(change, 'right'), column: 1 });
        if (leftEditor) leftEditor.setPosition({ lineNumber: anchorLine(change, 'left'), column: 1 });
    }, [changes]);

    const step = useCallback((direction: 1 | -1) => {
        if (changes.length === 0) return;
        if (current < 0) {
            // From the cursor, the first change at or after it.
            const cursor = editors.current.right?.getPosition()?.lineNumber ?? 1;
            const after = changeAtOrAfter(changes, 'right', cursor);
            reveal(direction === 1 ? (after < 0 ? 0 : after) : (after <= 0 ? changes.length - 1 : after - 1));
            return;
        }
        reveal((current + direction + changes.length) % changes.length);
    }, [changes, current, reveal]);

    // First change shown once the first diff arrives.
    const revealedFirst = useRef(false);
    useEffect(() => {
        if (revealedFirst.current || changes.length === 0) return;
        revealedFirst.current = true;
        reveal(0);
    }, [changes, reveal]);

    const saveSides = useCallback(() => {
        for (const side of [left, right]) if (side.kind === 'tab' && side.isDirty) onSaveTab(side.tabId);
    }, [left, right, onSaveTab]);

    useEffect(() => {
        if (!visible) return;
        onRegisterCommands({
            find: () => (editors.current.right ?? editors.current.left)?.getAction('actions.find')?.run(),
            save: saveSides,
            activeEditor: () => lastFocused.current,
        });
        return () => onRegisterCommands(null);
    }, [visible, onRegisterCommands, saveSides]);

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key !== 'F5' || !event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        step(event.shiftKey ? -1 : 1);
    };

    const toggle = (key: keyof DiffOptions) => setOptions(current => ({ ...current, [key]: !current[key] }));
    const currentChange = current >= 0 ? changes[current] : undefined;
    const ignoredOnly = !!result && result.changeCount === 0 && result.regions.length > 0;

    const header = (side: ResolvedSide, which: Side) => (
        <div className={`compare-pane-header compare-pane-${which}`}>
            <span className="compare-pane-title" title={sideTitle(side)}>{sideTitle(side)}</span>
            {sideReadOnly(side) && <span className="compare-badge">read-only</span>}
            {side.kind === 'tab' && side.isDirty && (
                <button type="button" className="log-button" onClick={() => onSaveTab(side.tabId)}>Save</button>
            )}
        </div>
    );

    return (
        <div className="compare-view" onKeyDown={onKeyDown}>
            <div className="compare-toolbar" role="toolbar" aria-label="Compare">
                <div className="log-toolbar-group">
                    <button type="button" className="log-button" title="First change" aria-label="First change" disabled={!changes.length} onClick={() => reveal(0)}>⇤</button>
                    <button type="button" className="log-button" title="Previous change (Shift+Alt+F5)" aria-label="Previous change" disabled={!changes.length} onClick={() => step(-1)}>↑</button>
                    <button type="button" className="log-button" title="Next change (Alt+F5)" aria-label="Next change" disabled={!changes.length} onClick={() => step(1)}>↓</button>
                    <button type="button" className="log-button" title="Last change" aria-label="Last change" disabled={!changes.length} onClick={() => reveal(changes.length - 1)}>⇥</button>
                    <span className="compare-summary" role="status">
                        {error ? `Couldn't compare: ${error}` : result ? changeSummary(result.changeCount, current, ignoredOnly) : 'Comparing…'}
                        {computing && result ? ' …' : ''}
                    </span>
                </div>
                <div className="log-toolbar-group">
                    <button type="button" className="log-button" disabled={!currentChange || rightReadOnly || !fresh}
                        title="Copy the current change to the right" onClick={() => currentChange && copyChange(currentChange, 'left')}>Copy to right →</button>
                    <button type="button" className="log-button" disabled={!currentChange || leftReadOnly || !fresh}
                        title="Copy the current change to the left" onClick={() => currentChange && copyChange(currentChange, 'right')}>← Copy to left</button>
                </div>
                <div className="log-toolbar-group">
                    <label className="log-check"><input type="checkbox" checked={options.ignoreTrimWhitespace} onChange={() => toggle('ignoreTrimWhitespace')} />Ignore leading/trailing spaces</label>
                    <label className="log-check"><input type="checkbox" checked={options.ignoreAllWhitespace} onChange={() => toggle('ignoreAllWhitespace')} />Ignore all whitespace</label>
                    <label className="log-check"><input type="checkbox" checked={options.ignoreCase} onChange={() => toggle('ignoreCase')} />Ignore case</label>
                    <label className="log-check"><input type="checkbox" checked={options.ignoreBlankLines} onChange={() => toggle('ignoreBlankLines')} />Ignore blank lines</label>
                </div>
                <div className="log-toolbar-group">
                    <button type="button" className={`log-toggle${inline ? '' : ' active'}`} aria-pressed={!inline} onClick={() => setInline(false)}>Side by side</button>
                    <button type="button" className={`log-toggle${inline ? ' active' : ''}`} aria-pressed={inline} onClick={() => setInline(true)}>Inline</button>
                    <button type="button" className="log-button" title="Swap left and right" onClick={onSwap}>Swap</button>
                </div>
            </div>
            {result?.approximate && (
                <div className="log-notice" role="status">
                    <span>These files differ in too many places to match every line exactly; part of the comparison is shown as one block.</span>
                </div>
            )}
            <div className={`compare-panes${inline ? ' inline' : ''}`}>
                {!inline && (
                    <div className="compare-pane">
                        {header(left, 'left')}
                        <div ref={leftHost} className="compare-editor" />
                    </div>
                )}
                <div className="compare-pane">
                    {inline
                        ? <div className="compare-pane-header"><span className="compare-pane-title">{sideTitle(left)} → {sideTitle(right)}</span>{rightReadOnly && <span className="compare-badge">read-only</span>}{right.kind === 'tab' && right.isDirty && <button type="button" className="log-button" onClick={() => onSaveTab(right.tabId)}>Save</button>}</div>
                        : header(right, 'right')}
                    <div ref={rightHost} className="compare-editor" />
                </div>
            </div>
        </div>
    );
}
