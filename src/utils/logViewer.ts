/**
 * Large File / Log viewer: the backend API (src-tauri/src/large_file.rs) and
 * the parts of the viewer that don't need React — highlight rules, line
 * severity, and reading the Go to box.
 *
 * Highlight rules are written in the syntax that JavaScript and Rust's regex
 * crate share (no look-around, no back-references), because "Export
 * highlighted lines" hands the same rules to the backend.
 */
import { invoke } from '@tauri-apps/api/core';

export interface LargeFileStatus {
    id: number;
    path: string;
    size: number;
    indexedBytes: number;
    lineCount: number;
    indexing: boolean;
    rotations: number;
    missing: boolean;
    error: string | null;
}

export interface LogLine {
    /** 0-based line index in the file. */
    number: number;
    text: string;
    truncated: boolean;
}

export interface LineRule {
    pattern: string;
    regex: boolean;
    caseSensitive: boolean;
}

export interface LineFilter {
    include: LineRule[];
    exclude: LineRule[];
    matchAll: boolean;
}

export interface FilterStatus {
    active: boolean;
    matched: number;
    scannedLines: number;
    done: boolean;
    error: string | null;
}

export interface SearchHit {
    line: number | null;
    stoppedAt: number | null;
}

export type ExportSelection =
    | { kind: 'all' }
    | { kind: 'filtered' }
    | { kind: 'range'; start: number; end: number }
    | { kind: 'matching'; rules: LineRule[] }
    | { kind: 'lines'; lines: number[] };

export const largeFileApi = {
    open: (path: string) => invoke<LargeFileStatus>('large_file_open', { path }),
    status: (id: number) => invoke<LargeFileStatus>('large_file_status', { id }),
    refresh: (id: number) => invoke<LargeFileStatus>('large_file_refresh', { id }),
    lines: (id: number, start: number, count: number) => invoke<LogLine[]>('large_file_lines', { id, start, count }),
    setFilter: (id: number, filter: LineFilter | null) => invoke<FilterStatus>('large_file_set_filter', { id, filter }),
    filterStatus: (id: number) => invoke<FilterStatus>('large_file_filter_status', { id }),
    filteredLines: (id: number, start: number, count: number) => invoke<LogLine[]>('large_file_filtered_lines', { id, start, count }),
    /** fromLine is exclusive; null searches from the start (or, backwards, the end) of the file. */
    search: (id: number, fromLine: number | null, backwards: boolean, rule: LineRule) =>
        invoke<SearchHit>('large_file_search', { id, fromLine, backwards, rule }),
    findTime: (id: number, target: string) => invoke<number | null>('large_file_find_time', { id, target }),
    exportLines: (id: number, destination: string, selection: ExportSelection) =>
        invoke<number>('large_file_export', { id, destination, selection }),
    close: (id: number) => invoke<void>('large_file_close', { id }),
};

export type HighlightColor = 'error' | 'warn' | 'info' | 'debug' | 'http' | 'id' | 'custom1' | 'custom2' | 'custom3';

export interface HighlightRule extends LineRule {
    id: string;
    label: string;
    color: HighlightColor;
    enabled: boolean;
    /** Error/Warning/Info/Debug: also colours the line's severity stripe. */
    severity?: 'error' | 'warn' | 'info' | 'debug';
}

export const DEFAULT_HIGHLIGHTS: HighlightRule[] = [
    {
        id: 'error', label: 'Errors', color: 'error', severity: 'error', enabled: true, regex: true, caseSensitive: true,
        pattern: '\\b(?:FATAL|CRITICAL|CRIT|SEVERE|ERROR|ERR|PANIC)\\b|\\blevel=(?:error|fatal|critical)\\b',
    },
    {
        id: 'warn', label: 'Warnings', color: 'warn', severity: 'warn', enabled: true, regex: true, caseSensitive: true,
        pattern: '\\b(?:WARNING|WARN)\\b|\\blevel=warn(?:ing)?\\b',
    },
    {
        id: 'info', label: 'Info', color: 'info', severity: 'info', enabled: true, regex: true, caseSensitive: true,
        pattern: '\\bINFO\\b|\\blevel=info\\b',
    },
    {
        id: 'debug', label: 'Debug and trace', color: 'debug', severity: 'debug', enabled: true, regex: true, caseSensitive: true,
        pattern: '\\b(?:DEBUG|TRACE|VERBOSE)\\b|\\blevel=(?:debug|trace)\\b',
    },
    {
        // Status after a quoted request line (common/combined log format),
        // after "status", or after the HTTP version.
        id: 'http', label: 'HTTP status codes', color: 'http', enabled: true, regex: true, caseSensitive: false,
        pattern: '" [1-5][0-9]{2}\\b|\\bstatus[=: "]+[1-5][0-9]{2}\\b|\\bHTTP/[0-9](?:\\.[0-9])? [1-5][0-9]{2}\\b',
    },
    {
        id: 'ids', label: 'Request IDs and UUIDs', color: 'id', enabled: true, regex: true, caseSensitive: false,
        pattern: '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b|\\b(?:request|req|trace|correlation)[_-]?id[=: ]+[A-Za-z0-9._:-]+',
    },
];

export const CUSTOM_COLORS: HighlightColor[] = ['custom1', 'custom2', 'custom3'];

const compiled = new Map<string, RegExp | null>();

/** The rule as a global JavaScript RegExp, or null if it doesn't compile or
 *  matches nothing useful (an empty pattern). Cached: the viewer re-renders
 *  its visible lines often. */
export function ruleRegExp(rule: LineRule): RegExp | null {
    if (!rule.pattern) return null;
    const key = `${rule.regex ? 'r' : 'p'}${rule.caseSensitive ? 'c' : 'i'}:${rule.pattern}`;
    if (compiled.has(key)) {
        const cached = compiled.get(key)!;
        if (cached) cached.lastIndex = 0;
        return cached;
    }
    let regex: RegExp | null;
    try {
        const source = rule.regex ? rule.pattern : rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(source, rule.caseSensitive ? 'gu' : 'giu');
    } catch {
        regex = null;
    }
    if (compiled.size > 200) compiled.clear();
    compiled.set(key, regex);
    return regex;
}

export interface Segment {
    text: string;
    /** Highlight class, or undefined for plain text. */
    color?: HighlightColor | 'search';
}

const MAX_MATCHES_PER_LINE = 200;

/**
 * Splits a line into plain and highlighted runs. Earlier rules win where
 * matches overlap; the search term (if any) is drawn over everything.
 */
export function highlightSegments(text: string, rules: HighlightRule[], search?: LineRule | null): Segment[] {
    if (!text) return [{ text }];
    const owner: (HighlightColor | 'search' | undefined)[] = new Array(text.length);
    const mark = (regex: RegExp | null, color: HighlightColor | 'search', overwrite: boolean) => {
        if (!regex) return;
        regex.lastIndex = 0;
        let count = 0;
        for (let match = regex.exec(text); match && count < MAX_MATCHES_PER_LINE; match = regex.exec(text)) {
            count++;
            if (match[0] === '') { regex.lastIndex++; continue; }
            for (let i = match.index; i < match.index + match[0].length; i++) {
                if (overwrite || owner[i] === undefined) owner[i] = color;
            }
        }
    };
    for (const rule of rules) if (rule.enabled) mark(ruleRegExp(rule), rule.color, false);
    if (search?.pattern) mark(ruleRegExp(search), 'search', true);

    const segments: Segment[] = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
        if (i === text.length || owner[i] !== owner[start]) {
            segments.push({ text: text.slice(start, i), color: owner[start] });
            start = i;
        }
    }
    return segments;
}

/** The first severity rule (Errors, Warnings, Info, Debug) the line matches. */
export function lineSeverity(text: string, rules: HighlightRule[]): HighlightRule['severity'] {
    for (const rule of rules) {
        if (!rule.enabled || !rule.severity) continue;
        const regex = ruleRegExp(rule);
        if (regex && regex.test(text)) {
            regex.lastIndex = 0;
            return rule.severity;
        }
    }
    return undefined;
}

export type GoToTarget =
    | { kind: 'line'; line: number }      // 1-based, as typed
    | { kind: 'percent'; percent: number }
    | { kind: 'time'; text: string }
    | { kind: 'invalid' };

/** The Go to box takes a line number, a percentage ("50%") or a time. */
export function parseGoTo(input: string): GoToTarget {
    const text = input.trim();
    if (!text) return { kind: 'invalid' };
    if (/^\d+$/.test(text)) {
        const line = Number(text);
        return Number.isSafeInteger(line) && line >= 1 ? { kind: 'line', line } : { kind: 'invalid' };
    }
    const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
    if (percent) {
        const value = Number(percent[1]);
        return value <= 100 ? { kind: 'percent', percent: value } : { kind: 'invalid' };
    }
    // Anything with a time of day is passed to the backend's timestamp parser.
    if (/\d{1,2}:\d{2}/.test(text)) return { kind: 'time', text };
    return { kind: 'invalid' };
}

/** The 0-based line a percentage of the file lands on. */
export function lineAtPercent(percent: number, lineCount: number): number {
    if (lineCount <= 0) return 0;
    return Math.min(lineCount - 1, Math.floor((percent / 100) * lineCount));
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Rows are fetched in blocks of this many; the viewer keeps the blocks near
 *  the visible range. */
export const LOG_CHUNK = 200;

/** The blocks needed to show rows [first, last], plus one block either side. */
export function chunksFor(first: number, last: number, total: number): number[] {
    if (total <= 0 || last < first) return [];
    const from = Math.max(0, Math.floor(first / LOG_CHUNK) - 1);
    const to = Math.min(Math.floor((total - 1) / LOG_CHUNK), Math.floor(last / LOG_CHUNK) + 1);
    const chunks: number[] = [];
    for (let chunk = from; chunk <= to; chunk++) chunks.push(chunk);
    return chunks;
}
