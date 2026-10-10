/** Crash-recovery snapshots are written in the order they were taken. */
import { describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../services/ErrorService', () => ({ errorService: { showWarning: vi.fn(), showError: vi.fn() } }));

import { saveSession } from './fileOperations';
import type { Tab } from '../types';

const tab = (content: string) => ({
    id: 't', path: null, title: 'Untitled-1', content, revision: 0, cursorLine: 1, cursorColumn: 1,
    isDirty: true, language: 'plaintext', isReadOnly: false, encoding: 'UTF-8', eol: 'LF',
    scrollTop: 0, scrollLeft: 0, isUntitled: true, externallyModified: false, externalChangeCount: 0,
} as unknown as Tab);

describe('saveSession', () => {
    it('starts a snapshot only after the previous one finished', async () => {
        let finishFirst!: () => void;
        invoke.mockReturnValueOnce(new Promise<void>(resolve => { finishFirst = resolve; }));
        invoke.mockResolvedValueOnce(undefined);

        const first = saveSession([tab('older')], 't');
        const second = saveSession([tab('newer')], 't');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(invoke).toHaveBeenCalledTimes(1);

        finishFirst();
        await Promise.all([first, second]);
        expect(invoke).toHaveBeenCalledTimes(2);
        const sessions = invoke.mock.calls.map(call => (call[1] as { session: { content?: string }[] }).session[0].content);
        expect(sessions).toEqual(['older', 'newer']);
    });
});
