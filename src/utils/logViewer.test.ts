import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
    chunksFor, DEFAULT_HIGHLIGHTS, highlightSegments, lineAtPercent, lineSeverity, LOG_CHUNK, parseGoTo, ruleRegExp,
    type HighlightRule,
} from './logViewer';

const rule = (id: string) => DEFAULT_HIGHLIGHTS.find(r => r.id === id)!;
const matches = (id: string, text: string) => {
    const regex = ruleRegExp(rule(id))!;
    return text.match(regex)?.map(String) ?? [];
};

describe('built-in log highlights', () => {
    it('find the usual severity words without matching ordinary prose', () => {
        expect(lineSeverity('2026-10-07 12:00:01 ERROR db: connection lost', DEFAULT_HIGHLIGHTS)).toBe('error');
        expect(lineSeverity('[WARN] disk 91% full', DEFAULT_HIGHLIGHTS)).toBe('warn');
        expect(lineSeverity('level=info msg="started"', DEFAULT_HIGHLIGHTS)).toBe('info');
        expect(lineSeverity('TRACE enter handler', DEFAULT_HIGHLIGHTS)).toBe('debug');
        // "error" inside a sentence or a word is not a log level.
        expect(lineSeverity('no errors were found', DEFAULT_HIGHLIGHTS)).toBeUndefined();
        expect(lineSeverity('TERRORIST', DEFAULT_HIGHLIGHTS)).toBeUndefined();
    });

    it('a line with several levels takes the most severe', () => {
        expect(lineSeverity('INFO retrying after ERROR', DEFAULT_HIGHLIGHTS)).toBe('error');
    });

    it('turning a rule off removes its colour', () => {
        const rules = DEFAULT_HIGHLIGHTS.map(r => (r.id === 'error' ? { ...r, enabled: false } : r));
        expect(lineSeverity('ERROR boom', rules)).toBeUndefined();
    });

    it('mark HTTP status codes and request ids', () => {
        expect(matches('http', '127.0.0.1 - - [07/Oct/2026:12:00:00 +0000] "GET / HTTP/1.1" 404 512')).toEqual(['" 404']);
        expect(matches('http', 'status=503 upstream timeout')).toEqual(['status=503']);
        expect(matches('http', 'took 200ms on port 443')).toEqual([]);
        expect(matches('ids', 'req 3f2b8c1e-9d4a-4e6b-8f0a-1b2c3d4e5f60 done')).toEqual(['3f2b8c1e-9d4a-4e6b-8f0a-1b2c3d4e5f60']);
        expect(matches('ids', 'request_id=abc-123 ok')).toEqual(['request_id=abc-123']);
    });

    it('use only syntax the backend regex engine also accepts (no look-around or back-references)', () => {
        for (const highlight of DEFAULT_HIGHLIGHTS) {
            expect(highlight.pattern).not.toMatch(/\(\?<?[=!]|\\[1-9]/);
        }
    });
});

describe('highlightSegments', () => {
    const rules: HighlightRule[] = [
        { id: 'a', label: 'a', pattern: 'ERROR', regex: false, caseSensitive: true, color: 'error', enabled: true },
        { id: 'b', label: 'b', pattern: 'ERR', regex: false, caseSensitive: true, color: 'custom1', enabled: true },
    ];

    it('splits a line into runs, earlier rules winning overlaps', () => {
        expect(highlightSegments('x ERROR y', rules)).toEqual([
            { text: 'x ', color: undefined },
            { text: 'ERROR', color: 'error' },
            { text: ' y', color: undefined },
        ]);
    });

    it('draws the search term over everything', () => {
        expect(highlightSegments('ERROR', rules, { pattern: 'RO', regex: false, caseSensitive: true })).toEqual([
            { text: 'ER', color: 'error' },
            { text: 'RO', color: 'search' },
            { text: 'R', color: 'error' },
        ]);
    });

    it('treats a plain pattern literally and survives an invalid regex', () => {
        const literal: HighlightRule = { ...rules[0], pattern: 'a.b', color: 'custom2' };
        expect(highlightSegments('axb a.b', [literal]).map(s => s.color)).toEqual([undefined, 'custom2']);
        const broken: HighlightRule = { ...rules[0], pattern: '(', regex: true };
        expect(highlightSegments('((', [broken])).toEqual([{ text: '((', color: undefined }]);
    });
});

describe('Go to box', () => {
    it('reads a line, a percentage or a time', () => {
        expect(parseGoTo(' 120 ')).toEqual({ kind: 'line', line: 120 });
        expect(parseGoTo('50%')).toEqual({ kind: 'percent', percent: 50 });
        expect(parseGoTo('12.5 %')).toEqual({ kind: 'percent', percent: 12.5 });
        expect(parseGoTo('2026-10-07 14:30')).toEqual({ kind: 'time', text: '2026-10-07 14:30' });
        expect(parseGoTo('14:30:05')).toEqual({ kind: 'time', text: '14:30:05' });
        expect(parseGoTo('0').kind).toBe('invalid');
        expect(parseGoTo('150%').kind).toBe('invalid');
        expect(parseGoTo('soon').kind).toBe('invalid');
    });

    it('maps a percentage onto a line that exists', () => {
        expect(lineAtPercent(0, 1000)).toBe(0);
        expect(lineAtPercent(50, 1000)).toBe(500);
        expect(lineAtPercent(100, 1000)).toBe(999);
        expect(lineAtPercent(100, 0)).toBe(0);
    });
});

describe('line blocks', () => {
    it('fetches the blocks around the visible rows, within the file', () => {
        expect(chunksFor(0, 30, 1_000_000)).toEqual([0, 1]);
        expect(chunksFor(LOG_CHUNK * 5 + 10, LOG_CHUNK * 5 + 40, 1_000_000)).toEqual([4, 5, 6]);
        expect(chunksFor(990, 1020, 1000)).toEqual([3, 4]);
        expect(chunksFor(0, 10, 0)).toEqual([]);
    });
});
