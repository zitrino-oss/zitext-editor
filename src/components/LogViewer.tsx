/**
 * Large File and Log viewer. The file stays on disk: the backend indexes line
 * positions and the viewer fetches only the lines near the visible rows, so a
 * multi-gigabyte log opens in about the time it takes to read it once, and
 * memory stays flat. Read-only by design.
 *
 * Rows are virtual: the viewer draws the visible lines and its own scrollbar,
 * because a scroll container tall enough for millions of lines exceeds what a
 * webview can lay out.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
    chunksFor, CUSTOM_COLORS, DEFAULT_HIGHLIGHTS, formatBytes, highlightSegments, largeFileApi, lineAtPercent,
    lineSeverity, LOG_CHUNK, parseGoTo,
    type ExportSelection, type FilterStatus, type HighlightRule, type LargeFileStatus, type LineRule, type LogLine,
} from '../utils/logViewer';
import { saveFileDialog } from '../utils/fileOperations';
import { errorService } from '../services/ErrorService';
import { fileNameOf, type ViewCommands } from '../utils/workspaceViews';
import { isMac } from '../utils/shortcuts';

interface LogViewerProps {
    path: string;
    /** False while another tab or view has the editor area. */
    visible: boolean;
    fontFamily: string;
    fontSize: number;
    onRegisterCommands: (commands: ViewCommands | null) => void;
}

interface FilterChip extends LineRule {
    id: number;
    exclude: boolean;
}

/** Most lines exported from a filtered selection in one go (the backend's
 *  limit for a list of lines); a plain selection exports as a range. */
const MAX_SELECTION_LINES = 100_000;
/** Most lines copied to the clipboard. */
const MAX_COPY_LINES = 10_000;
const LIVE_POLL_MS = 1000;
const BUSY_POLL_MS = 250;

let nextChipId = 1;
let nextRuleId = 1;

function errorText(error: unknown): string {
    return typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
}

/** False while the window is minimized or hidden. */
function usePageVisible(): boolean {
    const [pageVisible, setPageVisible] = useState(() => !document.hidden);
    useEffect(() => {
        const update = () => setPageVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    return pageVisible;
}

export function LogViewer({ path, visible, fontFamily, fontSize, onRegisterCommands }: LogViewerProps) {
    const [status, setStatus] = useState<LargeFileStatus | null>(null);
    const ready = status !== null;
    const pageVisible = usePageVisible();
    const [openError, setOpenError] = useState<string | null>(null);
    const idRef = useRef<number | null>(null);

    // Live (tail) mode
    const [live, setLive] = useState(true);
    const [autoScroll, setAutoScroll] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    // Filtering
    const [chips, setChips] = useState<FilterChip[]>([]);
    const [matchAll, setMatchAll] = useState(false);
    const [onlyMatching, setOnlyMatching] = useState(true);
    const [filterStatus, setFilterStatus] = useState<FilterStatus | null>(null);
    const [filterError, setFilterError] = useState<string | null>(null);
    const [filterInput, setFilterInput] = useState('');
    const [filterExclude, setFilterExclude] = useState(false);
    const [filterRegex, setFilterRegex] = useState(false);
    const [filterCase, setFilterCase] = useState(false);
    const filterGeneration = useRef(0);

    // Highlights
    const [rules, setRules] = useState<HighlightRule[]>(DEFAULT_HIGHLIGHTS);
    const [highlightsOpen, setHighlightsOpen] = useState(false);
    const [newKeyword, setNewKeyword] = useState('');

    // Find and Go to
    const [query, setQuery] = useState('');
    const [queryRegex, setQueryRegex] = useState(false);
    const [queryCase, setQueryCase] = useState(false);
    const [searching, setSearching] = useState<string | null>(null);
    const searchToken = useRef(0);
    const [goTo, setGoTo] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const findInputRef = useRef<HTMLInputElement>(null);
    const goToInputRef = useRef<HTMLInputElement>(null);

    // Rows, selection and bookmarks
    const [topRow, setTopRow] = useState(0);
    const [viewportRows, setViewportRows] = useState(30);
    const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
    const [bookmarks, setBookmarks] = useState<Set<number>>(() => new Set());
    const [exportOpen, setExportOpen] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const wheelRemainder = useRef(0);

    const rowHeight = Math.max(14, Math.round(fontSize * 1.5));
    const filterActive = chips.length > 0;
    const showFiltered = filterActive && onlyMatching;
    const mode = showFiltered ? 'f' : 'a';
    const total = showFiltered ? (filterStatus?.matched ?? 0) : (status?.lineCount ?? 0);
    const maxTop = Math.max(0, total - viewportRows + 1);
    const clampedTop = Math.min(topRow, maxTop);

    // ─── Line cache ─────────────────────────────────────────────────────
    // Blocks of LOG_CHUNK rows per mode ('a' all lines, 'f' filtered). A block
    // at the end can be partial while the file (or filter result) grows; it is
    // dropped whenever the row count changes so it gets fetched again.
    const cache = useRef(new Map<string, LogLine[]>());
    const inFlight = useRef(new Set<string>());
    const cacheEpoch = useRef(0);
    const [, setCacheTick] = useState(0);
    const lastTotals = useRef<Record<string, number>>({});

    const dropCache = useCallback((which?: 'a' | 'f') => {
        cacheEpoch.current++;
        for (const key of [...cache.current.keys()]) {
            if (!which || key.startsWith(`${which}:`)) cache.current.delete(key);
        }
        inFlight.current.clear();
        setCacheTick(t => t + 1);
    }, []);

    useEffect(() => {
        const previous = lastTotals.current[mode];
        lastTotals.current[mode] = total;
        if (previous === undefined || previous === total) return;
        // Drop the block that held the old end (it may have been partial)
        // and everything after it.
        const firstStale = Math.floor(Math.min(previous, total) / LOG_CHUNK);
        for (const key of [...cache.current.keys()]) {
            const [keyMode, chunk] = key.split(':');
            if (keyMode === mode && Number(chunk) >= firstStale) cache.current.delete(key);
        }
        // A fetch already on its way may bring back the old, shorter block;
        // discard what is in flight and fetch again.
        cacheEpoch.current++;
        inFlight.current.clear();
        setCacheTick(t => t + 1);
    }, [mode, total]);

    const rowLine = useCallback((row: number): LogLine | undefined => {
        const block = cache.current.get(`${mode}:${Math.floor(row / LOG_CHUNK)}`);
        return block?.[row % LOG_CHUNK];
    }, [mode]);

    useEffect(() => {
        const id = idRef.current;
        if (id === null || total === 0) return;
        const epoch = cacheEpoch.current;
        for (const chunk of chunksFor(clampedTop, clampedTop + viewportRows, total)) {
            const key = `${mode}:${chunk}`;
            if (cache.current.has(key) || inFlight.current.has(key)) continue;
            inFlight.current.add(key);
            const fetch = mode === 'f' ? largeFileApi.filteredLines : largeFileApi.lines;
            fetch(id, chunk * LOG_CHUNK, LOG_CHUNK)
                .then(lines => {
                    if (epoch !== cacheEpoch.current) return;
                    cache.current.set(key, lines);
                    // Keep the cache to the neighbourhood of the view.
                    if (cache.current.size > 60) {
                        const keep = new Set(chunksFor(clampedTop, clampedTop + viewportRows, total).map(c => `${mode}:${c}`));
                        for (const k of [...cache.current.keys()]) if (!keep.has(k)) cache.current.delete(k);
                    }
                    setCacheTick(t => t + 1);
                })
                .catch(() => { /* shown as an empty row; retried on the next scroll */ })
                .finally(() => inFlight.current.delete(key));
        }
    });

    // ─── Opening, closing and polling ───────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        setStatus(null);
        setOpenError(null);
        largeFileApi.open(path)
            .then(opened => {
                if (cancelled) {
                    void largeFileApi.close(opened.id);
                    return;
                }
                idRef.current = opened.id;
                setStatus(opened);
            })
            .catch(error => { if (!cancelled) setOpenError(errorText(error)); });
        return () => {
            cancelled = true;
            const id = idRef.current;
            idRef.current = null;
            if (id !== null) void largeFileApi.close(id);
        };
    }, [path]);

    const statusRef = useRef(status);
    statusRef.current = status;
    const filterStatusRef = useRef(filterStatus);
    filterStatusRef.current = filterStatus;

    useEffect(() => {
        if (!status) return;
        const busy = status.indexing || (filterActive && !!filterStatus && !filterStatus.done);
        // While the window is hidden or another tab is shown, only finish
        // indexing and filtering; following the file waits until the viewer
        // is visible again.
        const followLive = live && visible && pageVisible;
        if (!busy && !followLive) return;
        let stopped = false;
        const timer = window.setTimeout(async () => {
            const id = idRef.current;
            if (id === null || stopped) return;
            try {
                const next = followLive ? await largeFileApi.refresh(id) : await largeFileApi.status(id);
                if (stopped) return;
                const previous = statusRef.current;
                if (previous && next.rotations !== previous.rotations) {
                    dropCache();
                    // Line numbers now point into a different file.
                    setBookmarks(new Set());
                    setSelection(null);
                    setNotice('The file was replaced (log rotation). Showing the new file; bookmarks were cleared.');
                } else if (next.missing && !previous?.missing) {
                    setNotice('The file was deleted or moved. Showing what was already read.');
                }
                setStatus(next);
                if (filterActive) {
                    const filter = await largeFileApi.filterStatus(id);
                    if (!stopped) setFilterStatus(filter);
                }
            } catch {
                // The next tick tries again.
            }
        }, busy ? BUSY_POLL_MS : LIVE_POLL_MS);
        return () => { stopped = true; window.clearTimeout(timer); };
    }, [status, filterStatus, filterActive, live, visible, pageVisible, dropCache]);

    // Auto-scroll: keep the newest line in view as the file grows.
    useEffect(() => {
        if (autoScroll && live) setTopRow(Math.max(0, total - viewportRows + 1));
    }, [autoScroll, live, total, viewportRows]);

    // ─── Viewport size ──────────────────────────────────────────────────
    useLayoutEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const measure = () => setViewportRows(Math.max(1, Math.floor(body.clientHeight / rowHeight)));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        return () => observer.disconnect();
    }, [rowHeight, ready]);

    // ─── Filtering ──────────────────────────────────────────────────────
    useEffect(() => {
        const id = idRef.current;
        if (id === null) return;
        const generation = ++filterGeneration.current;
        const filter = chips.length === 0 ? null : {
            include: chips.filter(c => !c.exclude).map(({ pattern, regex, caseSensitive }) => ({ pattern, regex, caseSensitive })),
            exclude: chips.filter(c => c.exclude).map(({ pattern, regex, caseSensitive }) => ({ pattern, regex, caseSensitive })),
            matchAll,
        };
        largeFileApi.setFilter(id, filter)
            .then(next => {
                if (generation !== filterGeneration.current) return;
                setFilterError(null);
                setFilterStatus(filter ? next : null);
                dropCache('f');
                setSelection(null);
                setTopRow(0);
            })
            .catch(error => {
                if (generation === filterGeneration.current) setFilterError(errorText(error));
            });
    }, [chips, matchAll, ready, dropCache]);

    const addChip = () => {
        const pattern = filterInput.trim();
        if (!pattern) return;
        if (filterRegex) {
            try { new RegExp(pattern); } catch (error) {
                setFilterError(`Invalid regular expression: ${errorText(error)}`);
                return;
            }
        }
        setChips(current => [...current, { id: nextChipId++, pattern, regex: filterRegex, caseSensitive: filterCase, exclude: filterExclude }]);
        setFilterInput('');
        setOnlyMatching(true);
    };

    // ─── Navigation ─────────────────────────────────────────────────────
    const showRow = useCallback((row: number) => {
        setAutoScroll(false);
        setTopRow(Math.max(0, row - Math.floor(viewportRows / 3)));
        setSelection({ anchor: row, focus: row });
    }, [viewportRows]);

    /** Jumps to a line of the file. Line positions are file-wide, so the
     *  view switches to all lines (the filter is kept, ready to turn back on). */
    const revealLine = useCallback((line: number) => {
        if (showFiltered) {
            setOnlyMatching(false);
            setMessage('Showing all lines. Turn "Only matching" back on to see the filter again.');
        }
        showRow(line);
    }, [showFiltered, showRow]);

    /** The file line of a row, or undefined in filtered mode while the row
     *  isn't loaded yet. */
    const lineOfRow = (row: number): number | undefined => (showFiltered ? rowLine(row)?.number : row);
    const currentLine = (): number => lineOfRow(selection?.focus ?? clampedTop) ?? 0;

    const runGoTo = async () => {
        const id = idRef.current;
        if (id === null || !status) return;
        const target = parseGoTo(goTo);
        setMessage(null);
        if (target.kind === 'invalid') {
            setMessage('Enter a line number, a percentage such as 50%, or a time such as 2026-10-07 14:30:00.');
        } else if (target.kind === 'line') {
            revealLine(Math.min(target.line, Math.max(1, status.lineCount)) - 1);
        } else if (target.kind === 'percent') {
            revealLine(lineAtPercent(target.percent, status.lineCount));
        } else {
            try {
                const line = await largeFileApi.findTime(id, target.text);
                if (line === null) setMessage('No line has that time or a later one.');
                else revealLine(line);
            } catch (error) {
                setMessage(errorText(error));
            }
        }
    };

    const searchRule = useMemo<LineRule | null>(
        () => (query ? { pattern: query, regex: queryRegex, caseSensitive: queryCase } : null),
        [query, queryRegex, queryCase],
    );

    const runSearch = async (backwards: boolean) => {
        const id = idRef.current;
        if (id === null || !searchRule) return;
        if (searchRule.regex) {
            try { new RegExp(searchRule.pattern); } catch (error) {
                setMessage(`Invalid regular expression: ${errorText(error)}`);
                return;
            }
        }
        const token = ++searchToken.current;
        setMessage(null);
        // From the selected line (exclusive). With nothing selected, from the
        // top of the view, the first line shown included when searching down.
        // A row that isn't loaded yet (just scrolled to) searches the whole file.
        const base = lineOfRow(selection?.focus ?? clampedTop);
        let from: number | null = base === undefined ? null
            : selection || backwards ? base
            : base === 0 ? null : base - 1;
        try {
            // The backend searches for at most a few seconds per call and says
            // where it stopped; keep going until a hit or the end, unless the
            // user starts another search.
            for (;;) {
                setSearching(`Searching from line ${((from ?? 0) + 1).toLocaleString()}…`);
                const hit = await largeFileApi.search(id, from, backwards, searchRule);
                if (token !== searchToken.current) return;
                if (hit.line !== null) { revealLine(hit.line); break; }
                if (hit.stoppedAt === null) {
                    setMessage(backwards ? 'No earlier match.' : 'No later match.');
                    break;
                }
                from = hit.stoppedAt;
            }
        } catch (error) {
            if (token === searchToken.current) setMessage(errorText(error));
        } finally {
            if (token === searchToken.current) setSearching(null);
        }
    };


    // ─── Bookmarks ──────────────────────────────────────────────────────
    const toggleBookmark = (line: number) => {
        setBookmarks(current => {
            const next = new Set(current);
            if (next.has(line)) next.delete(line); else next.add(line);
            return next;
        });
    };

    const jumpToBookmark = (backwards: boolean) => {
        if (bookmarks.size === 0) { setMessage('No bookmarks yet. Click a line number to add one.'); return; }
        const sorted = [...bookmarks].sort((a, b) => a - b);
        const from = currentLine();
        const next = backwards
            ? [...sorted].reverse().find(line => line < from) ?? sorted[sorted.length - 1]
            : sorted.find(line => line > from) ?? sorted[0];
        revealLine(next);
    };

    // ─── Selection, copy and export ─────────────────────────────────────
    const selectedRows = selection
        ? { first: Math.min(selection.anchor, selection.focus), last: Math.max(selection.anchor, selection.focus) }
        : null;
    const selectedRowsRef = useRef(selectedRows);
    selectedRowsRef.current = selectedRows;

    /** Original line numbers of the selected rows, fetching rows that aren't
     *  loaded (a long shift-click selection). */
    const selectedLines = async (): Promise<LogLine[]> => {
        const id = idRef.current;
        if (id === null || !selectedRows) return [];
        const count = Math.min(selectedRows.last - selectedRows.first + 1, MAX_SELECTION_LINES);
        const fetch = showFiltered ? largeFileApi.filteredLines : largeFileApi.lines;
        const result: LogLine[] = [];
        for (let start = selectedRows.first; start < selectedRows.first + count; start += 1000) {
            result.push(...await fetch(id, start, Math.min(1000, selectedRows.first + count - start)));
        }
        return result;
    };

    const copySelection = async () => {
        if (!selectedRows) return;
        // Refused before anything is fetched: long log lines add up fast.
        if (selectedRows.last - selectedRows.first + 1 > MAX_COPY_LINES) {
            setMessage(`Copy takes at most ${MAX_COPY_LINES.toLocaleString()} lines; use Export → Selected lines for more.`);
            return;
        }
        try {
            const lines = await selectedLines();
            if (lines.some(line => line.truncated)) {
                setMessage('Some lines are longer than the viewer shows; they were copied as shown. Export keeps them whole.');
            }
            await writeText(lines.map(line => line.text).join('\n'));
        } catch (error) {
            errorService.showError('Copy failed', error as Error);
        }
    };

    // Copy follows the browser's copy event rather than the key: on macOS the
    // Edit menu answers Cmd+C before the page sees the key press. Text
    // selected with the mouse copies as usual; otherwise the selected rows do.
    const onCopy = (event: React.ClipboardEvent) => {
        const native = window.getSelection();
        if (native && !native.isCollapsed && bodyRef.current?.contains(native.anchorNode)) return;
        if (!selectedRows) return;
        event.preventDefault();
        const loaded: string[] = [];
        let truncated = false;
        for (let row = selectedRows.first; row <= selectedRows.last; row++) {
            const line = rowLine(row);
            if (!line) { void copySelection(); return; }
            truncated ||= line.truncated;
            loaded.push(line.text);
        }
        event.clipboardData.setData('text/plain', loaded.join('\n'));
        if (truncated) setMessage('Some lines are longer than the viewer shows; they were copied as shown. Export keeps them whole.');
    };

    const exportLines = async (selection: ExportSelection, label: string) => {
        setExportOpen(false);
        const id = idRef.current;
        if (id === null) return;
        const base = fileNameOf(path).replace(/\.[^.]*$/, '');
        const destination = await saveFileDialog(`${base}-${label}.log`);
        if (!destination) return;
        try {
            const written = await largeFileApi.exportLines(id, destination, selection);
            errorService.showSuccess(`Exported ${written.toLocaleString()} line${written === 1 ? '' : 's'} to ${fileNameOf(destination)}`);
        } catch (error) {
            errorService.showError('Export failed', error as Error);
        }
    };

    const exportSelected = async () => {
        if (!selectedRows) return;
        if (!showFiltered) {
            void exportLines({ kind: 'range', start: selectedRows.first, end: selectedRows.last }, 'selection');
            return;
        }
        if (selectedRows.last - selectedRows.first + 1 > MAX_SELECTION_LINES) {
            setMessage(`From the filtered view, Export → Selected lines takes at most ${MAX_SELECTION_LINES.toLocaleString()} lines. Use Export → Filtered lines for all of them.`);
            return;
        }
        try {
            const lines = await selectedLines();
            void exportLines({ kind: 'lines', lines: lines.map(line => line.number) }, 'selection');
        } catch (error) {
            errorService.showError('Export failed', error as Error);
        }
    };

    // WebKit (macOS) only enables Edit → Copy for a text selection; selected
    // rows aren't one, so it is enabled here by cancelling beforecopy.
    useEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const enableCopy = (event: Event) => { if (selectedRowsRef.current) event.preventDefault(); };
        body.addEventListener('beforecopy', enableCopy);
        return () => body.removeEventListener('beforecopy', enableCopy);
    }, [ready]);

    // ─── Commands from the app (Find, Go to Line) ───────────────────────
    useEffect(() => {
        if (!visible) return;
        onRegisterCommands({
            find: () => { findInputRef.current?.focus(); findInputRef.current?.select(); },
            goToLine: () => { goToInputRef.current?.focus(); goToInputRef.current?.select(); },
        });
        return () => onRegisterCommands(null);
    }, [visible, onRegisterCommands]);

    // ─── Scrolling and keys ─────────────────────────────────────────────
    const scrollBy = (rows: number) => {
        if (rows < 0) setAutoScroll(false);
        setTopRow(current => Math.max(0, Math.min(maxTop, Math.min(current, maxTop) + rows)));
    };

    const onWheel = (event: React.WheelEvent) => {
        const delta = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * viewportRows : event.deltaY / rowHeight;
        wheelRemainder.current += delta;
        const whole = Math.trunc(wheelRemainder.current);
        if (whole !== 0) {
            wheelRemainder.current -= whole;
            scrollBy(whole);
        }
    };

    const moveSelection = (row: number, extend: boolean) => {
        const target = Math.max(0, Math.min(total - 1, row));
        setSelection(current => ({ anchor: extend && current ? current.anchor : target, focus: target }));
        setAutoScroll(false);
        setTopRow(current => {
            const top = Math.min(current, maxTop);
            if (target < top) return target;
            if (target >= top + viewportRows - 1) return Math.max(0, target - viewportRows + 2);
            return top;
        });
    };

    const onBodyKeyDown = (event: React.KeyboardEvent) => {
        const mod = isMac ? event.metaKey : event.ctrlKey;
        const focus = selection?.focus ?? clampedTop;
        if (event.key === 'ArrowDown') moveSelection(focus + 1, event.shiftKey);
        else if (event.key === 'ArrowUp') moveSelection(focus - 1, event.shiftKey);
        else if (event.key === 'PageDown') moveSelection(focus + viewportRows - 1, event.shiftKey);
        else if (event.key === 'PageUp') moveSelection(focus - viewportRows + 1, event.shiftKey);
        else if (event.key === 'Home') moveSelection(0, event.shiftKey);
        else if (event.key === 'End') moveSelection(total - 1, event.shiftKey);
        else if (mod && event.key.toLowerCase() === 'a') setSelection({ anchor: 0, focus: Math.max(0, total - 1) });
        else if (event.key === 'F2' && mod) {
            const line = showFiltered ? rowLine(focus)?.number : focus;
            if (line !== undefined) toggleBookmark(line);
        } else if (event.key === 'F2') jumpToBookmark(event.shiftKey);
        else if (event.key === 'Escape') setSelection(null);
        else return;
        event.preventDefault();
        event.stopPropagation();
    };

    // Custom scrollbar
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbFraction = total > 0 ? Math.min(1, viewportRows / total) : 1;
    const positionFraction = maxTop > 0 ? clampedTop / maxTop : 0;
    const dragScroll = (clientY: number, grabOffset: number) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const thumbPx = Math.max(24, rect.height * thumbFraction);
        const usable = rect.height - thumbPx;
        if (usable <= 0) return;
        const fraction = Math.max(0, Math.min(1, (clientY - rect.top - grabOffset) / usable));
        setAutoScroll(false);
        setTopRow(Math.round(fraction * maxTop));
    };
    const onThumbMouseDown = (event: React.MouseEvent) => {
        event.preventDefault();
        const thumb = event.currentTarget.getBoundingClientRect();
        const grab = event.clientY - thumb.top;
        const move = (e: MouseEvent) => dragScroll(e.clientY, grab);
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };

    // ─── Rendering ──────────────────────────────────────────────────────
    const gutterDigits = String(Math.max(1, status?.lineCount ?? 1)).length;
    const visibleRows: number[] = [];
    for (let row = clampedTop; row < Math.min(total, clampedTop + viewportRows); row++) visibleRows.push(row);
    // Text is marked on screen only for a plain Find. A regular expression is
    // matched by the backend (whose engine can't hang); running a user's
    // pattern in JavaScript over log lines someone else wrote could freeze the
    // window, so a regex hit is shown by selecting its line instead.
    const activeSearch = searchRule && !searchRule.regex ? searchRule : null;

    if (openError) {
        return (
            <div className="log-viewer log-viewer-error" role="alert">
                <p><strong>{fileNameOf(path)}</strong> couldn't be opened.</p>
                <p>{openError}</p>
            </div>
        );
    }

    const indexedPercent = status && status.size > 0 ? Math.floor((status.indexedBytes / status.size) * 100) : 100;

    return (
        <div ref={rootRef} className="log-viewer" style={{ fontFamily, fontSize }}>
            <div className="log-toolbar" role="toolbar" aria-label="Log viewer">
                <div className="log-toolbar-group">
                    <input
                        ref={findInputRef}
                        className="log-input"
                        placeholder="Find"
                        aria-label="Find in file"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); void runSearch(e.shiftKey); }
                            else if (e.key === 'Escape') { setQuery(''); bodyRef.current?.focus(); }
                        }}
                    />
                    <button type="button" className={`log-toggle${queryRegex ? ' active' : ''}`} aria-pressed={queryRegex} title="Regular expression" onClick={() => setQueryRegex(v => !v)}>.*</button>
                    <button type="button" className={`log-toggle${queryCase ? ' active' : ''}`} aria-pressed={queryCase} title="Match case" onClick={() => setQueryCase(v => !v)}>Aa</button>
                    <button type="button" className="log-button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!query} onClick={() => void runSearch(true)}>↑</button>
                    <button type="button" className="log-button" title="Next match (Enter)" aria-label="Next match" disabled={!query} onClick={() => void runSearch(false)}>↓</button>
                </div>
                <div className="log-toolbar-group">
                    <input
                        ref={goToInputRef}
                        className="log-input log-input-narrow"
                        placeholder="Go to line, 50%, or time"
                        aria-label="Go to line, percentage or time"
                        value={goTo}
                        onChange={e => setGoTo(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runGoTo(); } }}
                    />
                </div>
                <div className="log-toolbar-group">
                    <button type="button" className={`log-toggle${live ? ' active' : ''}`} aria-pressed={live}
                        title="Watch the file for new lines (pause to stop reading updates)"
                        onClick={() => setLive(v => !v)}>{live ? 'Live' : 'Paused'}</button>
                    <button type="button" className={`log-toggle${autoScroll ? ' active' : ''}`} aria-pressed={autoScroll}
                        title="Keep the newest line in view" disabled={!live}
                        onClick={() => setAutoScroll(v => !v)}>Follow</button>
                    <button type="button" className="log-button" title="Jump to the latest line"
                        onClick={() => showRow(Math.max(0, total - 1))}>Latest</button>
                </div>
                <div className="log-toolbar-group">
                    <button type="button" className="log-button" title={`Previous bookmark (Shift+F2); ${isMac ? '⌘' : 'Ctrl+'}F2 or a click on a line number adds one`} onClick={() => jumpToBookmark(true)}>◀ Bookmark</button>
                    <button type="button" className="log-button" title="Next bookmark (F2)" onClick={() => jumpToBookmark(false)}>Bookmark ▶</button>
                    <div className="log-menu-anchor">
                        <button type="button" className={`log-button${highlightsOpen ? ' active' : ''}`} aria-expanded={highlightsOpen} onClick={() => { setHighlightsOpen(v => !v); setExportOpen(false); }}>Highlights</button>
                        {highlightsOpen && (
                            <div className="log-menu" role="menu">
                                {rules.map(rule => (
                                    <label key={rule.id} className="log-menu-item">
                                        <input type="checkbox" checked={rule.enabled}
                                            onChange={() => setRules(current => current.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r))} />
                                        <span className={`log-swatch log-hl-${rule.color}`} aria-hidden="true" />
                                        <span className="log-menu-label">{rule.label}</span>
                                        {!DEFAULT_HIGHLIGHTS.some(d => d.id === rule.id) && (
                                            <button type="button" className="log-chip-remove" aria-label={`Remove ${rule.label}`}
                                                onClick={e => { e.preventDefault(); setRules(current => current.filter(r => r.id !== rule.id)); }}>×</button>
                                        )}
                                    </label>
                                ))}
                                <div className="log-menu-add">
                                    <input className="log-input" placeholder="Keyword to highlight" aria-label="Keyword to highlight"
                                        value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addKeyword(); } }} />
                                    <button type="button" className="log-button" onClick={() => void addKeyword()}>Add</button>
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="log-menu-anchor">
                        <button type="button" className={`log-button${exportOpen ? ' active' : ''}`} aria-expanded={exportOpen} onClick={() => { setExportOpen(v => !v); setHighlightsOpen(false); }}>Export</button>
                        {exportOpen && (
                            <div className="log-menu" role="menu">
                                <button type="button" role="menuitem" className="log-menu-item" disabled={!filterActive || !!filterError}
                                    onClick={() => void exportLines({ kind: 'filtered' }, 'filtered')}>Filtered lines…</button>
                                <button type="button" role="menuitem" className="log-menu-item" disabled={!rules.some(r => r.enabled)}
                                    onClick={() => void exportLines({ kind: 'matching', rules: rules.filter(r => r.enabled).map(({ pattern, regex, caseSensitive }) => ({ pattern, regex, caseSensitive })) }, 'highlighted')}>Highlighted lines…</button>
                                <button type="button" role="menuitem" className="log-menu-item" disabled={!selectedRows}
                                    onClick={() => void exportSelected()}>Selected lines…</button>
                                <button type="button" role="menuitem" className="log-menu-item" disabled={bookmarks.size === 0}
                                    onClick={() => void exportLines({ kind: 'lines', lines: [...bookmarks] }, 'bookmarks')}>Bookmarked lines…</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="log-filterbar">
                <select className="log-select" aria-label="Filter type" value={filterExclude ? 'exclude' : 'include'} onChange={e => setFilterExclude(e.target.value === 'exclude')}>
                    <option value="include">Include</option>
                    <option value="exclude">Exclude</option>
                </select>
                <input
                    className="log-input"
                    placeholder={filterExclude ? 'Hide lines containing…' : 'Show lines containing…'}
                    aria-label="Filter text"
                    value={filterInput}
                    onChange={e => setFilterInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addChip(); } }}
                />
                <button type="button" className={`log-toggle${filterRegex ? ' active' : ''}`} aria-pressed={filterRegex} title="Regular expression" onClick={() => setFilterRegex(v => !v)}>.*</button>
                <button type="button" className={`log-toggle${filterCase ? ' active' : ''}`} aria-pressed={filterCase} title="Match case" onClick={() => setFilterCase(v => !v)}>Aa</button>
                <button type="button" className="log-button" onClick={addChip} disabled={!filterInput.trim()}>Add filter</button>
                {chips.map(chip => (
                    <span key={chip.id} className={`log-chip${chip.exclude ? ' exclude' : ''}`}>
                        {chip.exclude ? 'not ' : ''}{chip.regex ? `/${chip.pattern}/` : `“${chip.pattern}”`}{chip.caseSensitive ? ' (Aa)' : ''}
                        <button type="button" className="log-chip-remove" aria-label={`Remove filter ${chip.pattern}`}
                            onClick={() => setChips(current => current.filter(c => c.id !== chip.id))}>×</button>
                    </span>
                ))}
                {chips.filter(c => !c.exclude).length > 1 && (
                    <select className="log-select" aria-label="How include filters combine" value={matchAll ? 'all' : 'any'} onChange={e => setMatchAll(e.target.value === 'all')}>
                        <option value="any">Match any (OR)</option>
                        <option value="all">Match all (AND)</option>
                    </select>
                )}
                {filterActive && (
                    <label className="log-check">
                        <input type="checkbox" checked={onlyMatching} onChange={e => { setOnlyMatching(e.target.checked); setSelection(null); setTopRow(0); }} />
                        Only matching
                    </label>
                )}
                {filterActive && (
                    <button type="button" className="log-button" onClick={() => setChips([])}>Clear</button>
                )}
            </div>

            {(notice || message || filterError || status?.error || (filterActive && filterStatus?.error)) && (
                <div className="log-notice" role="status">
                    <span>{filterError ?? status?.error ?? message ?? (filterActive ? filterStatus?.error : null) ?? notice}</span>
                    <button type="button" className="log-chip-remove" aria-label="Dismiss"
                        onClick={() => { setNotice(null); setMessage(null); setFilterError(null); }}>×</button>
                </div>
            )}

            <div className="log-body-wrap">
                <div
                    ref={bodyRef}
                    className="log-body"
                    tabIndex={0}
                    role="grid"
                    aria-label={`${fileNameOf(path)} lines`}
                    aria-rowcount={total}
                    onWheel={onWheel}
                    onKeyDown={onBodyKeyDown}
                    onCopy={onCopy}
                >
                    {status && total === 0 && (
                        <div className="log-empty">
                            {status.indexing ? 'Reading the file…' : showFiltered ? (filterStatus?.done ? 'No lines match the filter.' : 'Filtering…') : 'The file is empty.'}
                        </div>
                    )}
                    {visibleRows.map(row => {
                        const line = rowLine(row);
                        const number = showFiltered ? line?.number : row;
                        const selected = !!selectedRows && row >= selectedRows.first && row <= selectedRows.last;
                        const marked = number !== undefined && bookmarks.has(number);
                        const severity = line ? lineSeverity(line.text, rules) : undefined;
                        return (
                            <div
                                key={row}
                                role="row"
                                aria-rowindex={row + 1}
                                aria-selected={selected}
                                className={`log-row${selected ? ' selected' : ''}${severity ? ` sev-${severity}` : ''}`}
                                style={{ height: rowHeight, lineHeight: `${rowHeight}px` }}
                                onMouseDown={e => {
                                    if (e.button !== 0) return;
                                    if ((e.target as HTMLElement).closest('.log-gutter')) return;
                                    setAutoScroll(false);
                                    setSelection(current => ({ anchor: e.shiftKey && current ? current.anchor : row, focus: row }));
                                }}
                            >
                                <span
                                    className={`log-gutter${marked ? ' bookmarked' : ''}`}
                                    style={{ width: `${gutterDigits + 2}ch` }}
                                    title={marked ? 'Remove bookmark' : 'Add bookmark'}
                                    onClick={() => { if (number !== undefined) toggleBookmark(number); }}
                                >
                                    {number === undefined ? '' : (number + 1).toLocaleString('en-US', { useGrouping: false })}
                                </span>
                                <span className="log-text">
                                    {line === undefined ? <span className="log-loading">…</span> : highlightSegments(line.text, rules, activeSearch).map((segment, i) =>
                                        segment.color
                                            ? <span key={i} className={`log-hl-${segment.color}`}>{segment.text}</span>
                                            : segment.text)}
                                    {line?.truncated && <span className="log-truncated" title="This line is longer than the viewer shows. Export keeps it whole."> …</span>}
                                </span>
                            </div>
                        );
                    })}
                </div>
                <div
                    ref={trackRef}
                    className="log-scrollbar"
                    aria-hidden="true"
                    onMouseDown={e => {
                        if (e.target !== e.currentTarget) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const thumbPx = Math.max(24, rect.height * thumbFraction);
                        dragScroll(e.clientY, thumbPx / 2);
                    }}
                >
                    {thumbFraction < 1 && (
                        <div
                            className="log-scrollbar-thumb"
                            style={{
                                height: `max(24px, ${thumbFraction * 100}%)`,
                                top: `calc((100% - max(24px, ${thumbFraction * 100}%)) * ${positionFraction})`,
                            }}
                            onMouseDown={onThumbMouseDown}
                        />
                    )}
                </div>
            </div>

            <div className="log-footer">
                <span>{fileNameOf(path)}</span>
                {status && <span>{formatBytes(status.size)}</span>}
                {status && <span>{status.lineCount.toLocaleString()} lines{status.indexing ? ` (reading… ${indexedPercent}%)` : ''}</span>}
                {filterActive && filterStatus && (
                    <span>
                        {filterStatus.matched.toLocaleString()} matching
                        {!filterStatus.done && ` (filtering… ${status && status.lineCount > 0 ? Math.min(100, Math.floor((filterStatus.scannedLines / status.lineCount) * 100)) : 0}%)`}
                    </span>
                )}
                {selectedRows && <span>{(selectedRows.last - selectedRows.first + 1).toLocaleString()} selected</span>}
                {bookmarks.size > 0 && <span>{bookmarks.size} bookmarked</span>}
                {searching && <span>{searching}</span>}
                {status?.missing && <span className="log-footer-warn">File no longer on disk</span>}
                <span className="log-footer-hint">Read-only</span>
            </div>
        </div>
    );

    /** Custom highlights are plain keywords (see activeSearch for why not
     *  regular expressions). */
    async function addKeyword() {
        const pattern = newKeyword.trim();
        if (!pattern) return;
        const used = rules.filter(r => CUSTOM_COLORS.includes(r.color)).length;
        setRules(current => [...current, {
            id: `custom-${nextRuleId++}`,
            label: pattern,
            pattern,
            regex: false,
            caseSensitive: false,
            color: CUSTOM_COLORS[used % CUSTOM_COLORS.length],
            enabled: true,
        }]);
        setNewKeyword('');
    }
}
