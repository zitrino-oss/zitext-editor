// @vitest-environment jsdom
/**
 * Dialog, settings and update polish: the autosave delay field, Escape in
 * dialogs, the update prompt and version comparison, font choices, the
 * diagnostics panel, and the same tab in both panes.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => {
    (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
    window.matchMedia ??= ((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return { editors: [] as Record<string, unknown>[] };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('../utils/editorModels', () => ({ modelUriForTab: (id: string) => `inmemory://tab/${id}` }));
vi.mock('./EditorPanel', () => ({
    EditorPanel: (props: Record<string, unknown>) => { captured.editors.push(props); return null; },
}));

import { NumberRow } from './SettingsModal';
import { DialogFocusManager } from './DialogFocusManager';
import { UpdateAvailableModal } from './UpdateAvailableModal';
import { SplitView } from './SplitView';
import { compareVersions, parseManifest } from '../hooks/useUpdateChecker';
import { FONT_FAMILIES, UI_FONTS } from '../utils/fontOptions';
import { SUPERSEDED_DEFAULTS } from '../state/useSettingsManager';
import { getHealthSummary, startSession } from '../utils/sessionHealth';
import type { Settings, Tab } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; captured.editors.length = 0; });

function render(node: React.ReactNode) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    cleanup = () => { act(() => root.unmount()); host.remove(); };
    return { host, rerender: (next: React.ReactNode) => act(() => root.render(next)) };
}
const setValue = (input: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('Autosave delay field', () => {
    it('lets you type a value and clamps it when you leave the field', () => {
        const onChange = vi.fn();
        const { host } = render(<NumberRow label="Delay" value={1000} onChange={onChange} min={500} max={10000} />);
        const input = host.querySelector('input') as HTMLInputElement;
        for (const partial of ['1', '15', '150', '1500']) setValue(input, partial);
        expect(onChange).not.toHaveBeenCalled();
        act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
        expect(onChange).toHaveBeenCalledWith(1500);
    });
});

describe('Escape closes dialogs', () => {
    it('closes the top dialog the way clicking outside does, once', () => {
        const closeLower = vi.fn();
        const closeUpper = vi.fn();
        render(
            <>
                <DialogFocusManager />
                <div className="modal-overlay" onClick={closeLower}><div className="modal">lower</div></div>
                <div className="modal-overlay" onClick={closeUpper}><div className="modal">upper</div></div>
            </>,
        );
        act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(closeUpper).toHaveBeenCalledTimes(1);
        expect(closeLower).not.toHaveBeenCalled();
    });

    it('leaves a dialog alone when it used Escape itself', () => {
        const close = vi.fn();
        const { host } = render(
            <>
                <DialogFocusManager />
                <div className="modal-overlay" onClick={close}>
                    <div className="modal"><input onKeyDown={e => e.preventDefault()} /></div>
                </div>
            </>,
        );
        const input = host.querySelector('input') as HTMLInputElement;
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(close).not.toHaveBeenCalled();
    });
});

describe('Update prompt', () => {
    it('Later and Download put the prompt off; only Skip is permanent; no button takes focus', () => {
        const onLater = vi.fn();
        const onSkip = vi.fn();
        const { host } = render(<UpdateAvailableModal update={{ version: '3.0.0', releaseDate: '' }} onLater={onLater} onSkip={onSkip} />);
        const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
        expect(host.querySelector('[autofocus]')).toBeNull();
        expect(host.querySelector('[data-focus-dialog]')).not.toBeNull();
        act(() => button('Download').click());
        act(() => button('Remind me later').click());
        expect(onLater).toHaveBeenCalledTimes(2);
        expect(onSkip).not.toHaveBeenCalled();
        act(() => button('Skip this version').click());
        expect(onSkip).toHaveBeenCalledTimes(1);
    });

    it('Escape on a dialog above the update prompt leaves the prompt alone', () => {
        const onLater = vi.fn();
        const closeTop = vi.fn();
        render(
            <>
                <DialogFocusManager />
                <UpdateAvailableModal update={{ version: '3.0.0', releaseDate: '' }} onLater={onLater} onSkip={() => {}} />
                <div className="modal-overlay" onClick={closeTop}><div className="modal">settings</div></div>
            </>,
        );
        act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(closeTop).toHaveBeenCalledTimes(1);
        expect(onLater).not.toHaveBeenCalled();
    });

    it('compares versions by SemVer, including pre-releases', () => {
        expect(compareVersions('2.2.0', '2.2.0-rc.1')).toBe(1);
        expect(compareVersions('2.2.0-rc.2', '2.2.0-rc.10')).toBe(-1);
        expect(compareVersions('2.2.0-alpha', '2.2.0-1')).toBe(1);
        expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
        expect(compareVersions('2.1.5', '2.1.5')).toBe(0);
        expect(compareVersions('latest', '2.1.5')).toBeNull();
    });

    it('accepts only a well-formed manifest', () => {
        expect(parseManifest('{"version":"2.2.0","releaseDate":"2026-10-01"}')).toEqual({ version: '2.2.0', releaseDate: '2026-10-01' });
        expect(parseManifest('{"version":2}')).toBeNull();
        expect(parseManifest('{"version":"2.2.0","releaseDate":{"x":1}}')).toEqual({ version: '2.2.0', releaseDate: '' });
        // Valid JSON, only too large: the size limit itself must reject it.
        expect(parseManifest(JSON.stringify({ version: '2.2.0', releaseDate: '', pad: 'x'.repeat(70_000) }))).toBeNull();
    });
});

describe('Font choices', () => {
    it('no option is a stack that gets migrated away on load', () => {
        const migrated = [...SUPERSEDED_DEFAULTS.fontFamily, ...SUPERSEDED_DEFAULTS.uiFont];
        for (const option of [...FONT_FAMILIES, ...UI_FONTS]) {
            expect(migrated, option.label).not.toContain(option.value);
        }
    });
});

describe('Diagnostics', () => {
    it('does not count the running session as a crash, but does count an earlier unclosed one', () => {
        localStorage.clear();
        // A previous run that never ended (crashed).
        localStorage.setItem('session_health_log', JSON.stringify([
            { id: 'old', start: Date.now() - 60_000, end: null, fileCount: 1, errorCount: 0 },
        ]));
        startSession();
        const summary = getHealthSummary();
        expect(summary.crashedSessions).toBe(1);
        expect(summary.totalSessions).toBe(1);
    });
});

describe('Same tab in both panes', () => {
    it('the right pane keeps its own cursor', () => {
        const tab = { id: 't', path: '/p/a.ts', title: 'a.ts', content: 'x', revision: 0, cursorLine: 1, cursorColumn: 1,
            isDirty: false, language: 'typescript', isReadOnly: false, encoding: 'UTF-8', eol: 'LF', scrollTop: 0, scrollLeft: 0,
            isUntitled: false, externallyModified: false, externalChangeCount: 0 } as unknown as Tab;
        const onRightCursorChange = vi.fn();
        const noop = () => {};
        render(
            <SplitView leftTab={tab} rightTab={tab} settings={{} as Settings}
                onLeftChange={noop} onRightChange={noop} onLeftCursorChange={noop} onRightCursorChange={onRightCursorChange}
                onLeftScrollChange={noop} onRightScrollChange={noop} onLeftEditorReady={noop} onRightEditorReady={noop} />,
        );
        const right = () => captured.editors[captured.editors.length - 1];
        act(() => (right().onCursorChange as (l: number, c: number) => void)(40, 2));
        expect(onRightCursorChange).not.toHaveBeenCalled();
        expect(right().cursorLine).toBe(40);
        expect(captured.editors[captured.editors.length - 2].cursorLine).toBe(1);
    });
});
