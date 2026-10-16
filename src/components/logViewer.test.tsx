// @vitest-environment jsdom
/**
 * Large File / Log viewer against an in-memory stand-in for the backend
 * (src-tauri/src/large_file.rs has its own tests): opening and closing,
 * filtering, Go to, bookmarks and export, Find, and following a rotated log.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRule { pattern: string; regex: boolean; caseSensitive: boolean }

const fake = vi.hoisted(() => {
    const state = {
        lines: [] as string[],
        rotations: 0,
        filter: null as null | { include: FakeRule[]; exclude: FakeRule[]; matchAll: boolean },
        matches: [] as number[],
        calls: [] as [string, Record<string, unknown>][],
        saveTo: '/out/export.log' as string | null,
        filterError: null as string | null,
    };
    const test = (rule: FakeRule, text: string) => rule.regex
        ? new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i').test(text)
        : rule.caseSensitive ? text.includes(rule.pattern) : text.toLowerCase().includes(rule.pattern.toLowerCase());
    const status = () => ({
        id: 1, path: '/logs/app.log', size: state.lines.join('\n').length, indexedBytes: state.lines.join('\n').length,
        lineCount: state.lines.length, indexing: false, rotations: state.rotations, missing: false, error: null,
    });
    const filterStatus = () => ({ active: !!state.filter, matched: state.matches.length, scannedLines: state.lines.length, done: true, error: state.filterError });
    const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
        state.calls.push([command, args]);
        const line = (n: number) => ({ number: n, text: state.lines[n], truncated: false });
        switch (command) {
            case 'large_file_open': case 'large_file_status': case 'large_file_refresh': return status();
            case 'large_file_lines': {
                const start = args.start as number;
                return state.lines.slice(start, start + (args.count as number)).map((_, i) => line(start + i));
            }
            case 'large_file_set_filter': {
                state.filter = args.filter as typeof state.filter;
                const f = state.filter;
                state.matches = f ? state.lines.flatMap((text, n) => {
                    const includes = f.include.length === 0 || (f.matchAll ? f.include.every(r => test(r, text)) : f.include.some(r => test(r, text)));
                    return includes && !f.exclude.some(r => test(r, text)) ? [n] : [];
                }) : [];
                return filterStatus();
            }
            case 'large_file_filter_status': return filterStatus();
            case 'large_file_filtered_lines': {
                const start = args.start as number;
                return state.matches.slice(start, start + (args.count as number)).map(line);
            }
            case 'large_file_search': {
                const rule = args.rule as FakeRule;
                const from = args.fromLine as number;
                const order = args.backwards
                    ? Array.from({ length: from }, (_, i) => from - 1 - i)
                    : Array.from({ length: Math.max(0, state.lines.length - from - 1) }, (_, i) => from + 1 + i);
                return { line: order.find(n => test(rule, state.lines[n])) ?? null, stoppedAt: null };
            }
            case 'large_file_find_time': return null;
            case 'large_file_export': return 1;
            case 'large_file_close': return undefined;
        }
        throw new Error(`unexpected command ${command}`);
    });
    return { state, invoke };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(async () => undefined) }));
vi.mock('../utils/fileOperations', () => ({ saveFileDialog: vi.fn(async () => fake.state.saveTo) }));
vi.mock('../utils/heavyTasks', () => ({ checkRegexSpeed: vi.fn(async () => 'ok') }));
vi.mock('../services/ErrorService', () => ({ errorService: { showError: vi.fn(), showWarning: vi.fn(), showSuccess: vi.fn() } }));

import { LogViewer } from './LogViewer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does no layout: give the line area a height and provide ResizeObserver.
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('log-body') ? 420 : 0; },
});
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const flush = async () => {
    for (let i = 0; i < 6; i++) {
        await act(async () => {
            if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
            else await new Promise(r => setTimeout(r, 0));
        });
    }
};

let unmount: (() => void) | undefined;
afterEach(() => { unmount?.(); unmount = undefined; vi.useRealTimers(); });
beforeEach(() => {
    fake.state.lines = Array.from({ length: 1000 }, (_, n) => `2026-10-07 12:00:${String(n % 60).padStart(2, '0')} ${n % 10 === 0 ? 'ERROR' : 'INFO'} event ${n}`);
    fake.state.rotations = 0;
    fake.state.filter = null;
    fake.state.matches = [];
    fake.state.filterError = null;
    fake.state.calls = [];
    fake.invoke.mockClear();
});

async function render() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const commands = { current: null as null | { find?: () => void; goToLine?: () => void } };
    act(() => root.render(
        <LogViewer path="/logs/app.log" visible fontFamily="monospace" fontSize={14} onRegisterCommands={c => { commands.current = c; }} />,
    ));
    unmount = () => { act(() => root.unmount()); host.remove(); };
    await flush();
    return { host, commands };
}

const rowNumbers = (host: HTMLElement) => [...host.querySelectorAll('.log-row .log-gutter')].map(g => g.textContent);
const typeInto = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
});
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })); });
const input = (host: HTMLElement, label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement;

describe('Large File / Log viewer', () => {
    it('shows only the lines in view, with numbers and severity, and closes the file when it goes', async () => {
        const { host } = await render();
        expect(rowNumbers(host).slice(0, 3)).toEqual(['1', '2', '3']);
        expect(host.querySelectorAll('.log-row').length).toBe(20); // 420px / 21px rows
        expect(host.querySelector('.log-row')!.className).toContain('sev-error');
        expect(host.textContent).toContain('1,000 lines');
        const fetched = fake.state.calls.filter(([c]) => c === 'large_file_lines');
        expect(fetched.every(([, args]) => (args.count as number) <= 200)).toBe(true);
        unmount!();
        unmount = undefined;
        expect(fake.state.calls.some(([c, args]) => c === 'large_file_close' && args.id === 1)).toBe(true);
    });

    it('filters to matching lines, keeping their line numbers in the file', async () => {
        const { host } = await render();
        typeInto(input(host, 'Filter text'), 'ERROR');
        press(input(host, 'Filter text'), 'Enter');
        await flush();
        expect(fake.state.calls.filter(([c]) => c === 'large_file_set_filter').slice(-1)[0]?.[1].filter).toEqual({
            include: [{ pattern: 'ERROR', regex: false, caseSensitive: false }], exclude: [], matchAll: false,
        });
        expect(rowNumbers(host).slice(0, 3)).toEqual(['1', '11', '21']);
        expect(host.textContent).toContain('100 matching');

        // An exclude filter narrows it further.
        act(() => {
            const select = host.querySelector('select[aria-label="Filter type"]') as HTMLSelectElement;
            select.value = 'exclude';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        typeInto(input(host, 'Filter text'), 'event 1');
        press(input(host, 'Filter text'), 'Enter');
        await flush();
        // "event 10"…"event 19" are gone; "event 0" doesn't contain "event 1".
        expect(rowNumbers(host).slice(0, 3)).toEqual(['1', '21', '31']);
    });

    it('goes to a line or a percentage, leaving the filter view to do so', async () => {
        const { host, commands } = await render();
        typeInto(input(host, 'Filter text'), 'ERROR');
        press(input(host, 'Filter text'), 'Enter');
        await flush();

        act(() => commands.current?.goToLine?.());
        expect(document.activeElement).toBe(input(host, 'Go to line, percentage or time'));
        typeInto(input(host, 'Go to line, percentage or time'), '500');
        press(input(host, 'Go to line, percentage or time'), 'Enter');
        await flush();
        expect(host.querySelector('.log-row.selected .log-gutter')?.textContent).toBe('500');
        expect(host.textContent).toContain('Showing all lines');

        typeInto(input(host, 'Go to line, percentage or time'), '90%');
        press(input(host, 'Go to line, percentage or time'), 'Enter');
        await flush();
        expect(host.querySelector('.log-row.selected .log-gutter')?.textContent).toBe('901');
    });

    it('bookmarks lines and exports them, and exports the filtered lines', async () => {
        const { host } = await render();
        const gutters = host.querySelectorAll('.log-row .log-gutter');
        act(() => { (gutters[2] as HTMLElement).click(); });
        act(() => { (gutters[5] as HTMLElement).click(); });
        expect(host.querySelectorAll('.log-gutter.bookmarked').length).toBe(2);

        act(() => button(host, 'Export').click());
        act(() => button(host, 'Bookmarked lines…').click());
        await flush();
        const exported = fake.state.calls.filter(([c]) => c === 'large_file_export');
        expect(exported[0][1]).toEqual({ id: 1, destination: '/out/export.log', selection: { kind: 'lines', lines: [2, 5] } });

        // No destination chosen: nothing is written.
        fake.state.saveTo = null;
        act(() => button(host, 'Export').click());
        act(() => button(host, 'Highlighted lines…').click());
        await flush();
        expect(fake.state.calls.filter(([c]) => c === 'large_file_export')).toHaveLength(1);
        fake.state.saveTo = '/out/export.log';
    });

    it('finds the next and previous match from the selected line', async () => {
        const { host, commands } = await render();
        act(() => commands.current?.find?.());
        const find = input(host, 'Find in file');
        expect(document.activeElement).toBe(find);
        typeInto(find, 'event 42');
        press(find, 'Enter');
        await flush();
        expect(host.querySelector('.log-row.selected .log-gutter')?.textContent).toBe('43');
        expect(host.querySelector('.log-row.selected .log-hl-search')?.textContent).toBe('event 42');
        press(find, 'Enter', { shiftKey: true });
        await flush();
        expect(host.textContent).toContain('No earlier match.');
    });

    it('follows a growing log and says when it was rotated', async () => {
        vi.useFakeTimers();
        const { host } = await render();
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        fake.state.lines.push('2026-10-07 12:01:00 ERROR appended');
        await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
        expect(host.textContent).toContain('1,001 lines');

        act(() => { (host.querySelector('.log-row .log-gutter') as HTMLElement).click(); });
        expect(host.querySelectorAll('.log-gutter.bookmarked').length).toBe(1);
        fake.state.lines = ['new file line'];
        fake.state.rotations = 1;
        await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
        expect(host.textContent).toContain('log rotation');
        expect(host.textContent).toContain('1 lines');
        // Bookmarks pointed into the old file.
        expect(host.textContent).toContain('bookmarks were cleared');
        expect(host.querySelectorAll('.log-gutter.bookmarked').length).toBe(0);

        // Paused: no more reads.
        act(() => button(host, 'Live').click());
        const before = fake.state.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
        expect(fake.state.calls.filter(([c]) => c === 'large_file_refresh').length)
            .toBe(fake.state.calls.slice(0, before).filter(([c]) => c === 'large_file_refresh').length);
    });

    it('never runs a regular expression from Find over the lines in JavaScript', async () => {
        const { host } = await render();
        const find = input(host, 'Find in file');
        act(() => (host.querySelector('button[title="Regular expression"]') as HTMLButtonElement).click());
        typeInto(find, 'event 4[0-9]');
        press(find, 'Enter');
        await flush();
        // The backend found it and the line is selected, but the text isn't marked.
        expect(host.querySelector('.log-row.selected .log-gutter')?.textContent).toBe('41');
        expect(host.querySelector('.log-hl-search')).toBeNull();
    });

    it('custom highlights are plain keywords', async () => {
        const { host } = await render();
        act(() => button(host, 'Highlights').click());
        expect(host.querySelector('.log-menu-add button[title="Regular expression"]')).toBeNull();
        typeInto(input(host, 'Keyword to highlight'), 'event 7');
        await act(async () => { button(host, 'Add').click(); });
        expect([...host.querySelectorAll('.log-hl-custom1')].map(e => e.textContent)).toContain('event 7');
    });

    it('says when a filter stopped at its limit', async () => {
        fake.state.filterError = 'More than 10000000 lines match, so only the first 10000000 are shown. Narrow the filter to see the rest.';
        const { host } = await render();
        typeInto(input(host, 'Filter text'), 'INFO');
        press(input(host, 'Filter text'), 'Enter');
        await flush();
        expect(host.textContent).toContain('Narrow the filter');
    });

    it('refuses to copy a huge selection before reading any of it', async () => {
        fake.state.lines = Array.from({ length: 50_000 }, (_, n) => `line ${n}`);
        const { host } = await render();
        const body = host.querySelector('.log-body') as HTMLElement;
        press(body, 'a', { metaKey: true, ctrlKey: true });
        const before = fake.state.calls.filter(([c]) => c === 'large_file_lines').length;
        act(() => { body.dispatchEvent(new Event('copy', { bubbles: true })); });
        await flush();
        expect(host.textContent).toContain('Copy takes at most 10,000 lines');
        // Only the visible blocks may have been fetched, never the selection.
        const fetched = fake.state.calls.filter(([c]) => c === 'large_file_lines').slice(before);
        expect(fetched.every(([, args]) => (args.count as number) <= 200)).toBe(true);
    });
});
