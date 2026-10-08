import { describe, expect, it } from 'vitest';
import type { Tab } from '../types';
import {
    buildSessionSnapshot,
    MAX_RECOVERY_BUFFER_BYTES,
    MAX_SESSION_ENTRIES,
    RECOVERY_CONTENT_BUDGET_BYTES,
} from './sessionSnapshot';

// Recovery limits used to reject the whole snapshot.
function tab(overrides: Partial<Tab>): Tab {
    return {
        id: Math.random().toString(36),
        path: null,
        title: 'Untitled-1',
        content: '',
        revision: 0,
        cursorLine: 1,
        cursorColumn: 1,
        isDirty: false,
        language: 'plaintext',
        isReadOnly: false,
        encoding: 'UTF-8',
        diskVersion: null,
        eol: 'LF',
        scrollTop: 0,
        scrollLeft: 0,
        isUntitled: true,
        externallyModified: false,
        externalChangeCount: 0,
        ...overrides,
    };
}

describe('buildSessionSnapshot', () => {
    it('stores dirty file content with its base disk version, and clean files without content', () => {
        const version = { modified: 1, size: 5, hash: 'h1' };
        const dirty = tab({ path: '/a.txt', title: 'a.txt', content: 'edits', isDirty: true, diskVersion: version, isUntitled: false });
        const clean = tab({ path: '/b.txt', title: 'b.txt', content: 'disk', isUntitled: false });
        const { session, omitted } = buildSessionSnapshot([dirty, clean], dirty.id);
        expect(omitted).toEqual([]);
        expect(session[0]).toMatchObject({ path: '/a.txt', is_dirty: true, content: 'edits', base_version: version, is_active: true });
        expect(session[1]).toEqual(expect.not.objectContaining({ content: expect.anything() }));
    });

    it('keeps whitespace-only untitled buffers and skips empty ones', () => {
        const spaces = tab({ title: 'Untitled-1', content: '    \n\t' });
        const empty = tab({ title: 'Untitled-2', content: '' });
        const { session } = buildSessionSnapshot([spaces, empty], null);
        expect(session.map(s => s.path)).toEqual(['Untitled-1']);
    });

    it('stays within budget and reports what it could not keep instead of failing', () => {
        const big = 'x'.repeat(MAX_RECOVERY_BUFFER_BYTES - 16);
        const tabs = [1, 2, 3].map(n => tab({ title: `Untitled-${n}`, content: big }));
        const huge = tab({ path: '/huge.log', title: 'huge.log', content: 'y'.repeat(MAX_RECOVERY_BUFFER_BYTES + 1), isDirty: true, isUntitled: false });
        const { session, omitted } = buildSessionSnapshot([...tabs, huge], null);

        const kept = session.filter(s => s.content !== undefined);
        const keptBytes = kept.reduce((sum, s) => sum + JSON.stringify(s.content).length, 0);
        expect(keptBytes).toBeLessThanOrEqual(RECOVERY_CONTENT_BUDGET_BYTES);
        expect(kept).toHaveLength(2);
        expect(omitted).toEqual(['Untitled-3', 'huge.log']);
        // The over-budget dirty file still reopens from disk.
        expect(session.find(s => s.path === '/huge.log')).toMatchObject({ path: '/huge.log' });
        expect(session.find(s => s.path === '/huge.log')?.content).toBeUndefined();
    });

    it('gives the active tab priority for the budget', () => {
        const big = 'x'.repeat(MAX_RECOVERY_BUFFER_BYTES - 16);
        const tabs = [1, 2, 3].map(n => tab({ title: `Untitled-${n}`, content: big }));
        const { omitted } = buildSessionSnapshot(tabs, tabs[2].id);
        expect(omitted).not.toContain('Untitled-3');
    });

    it('caps the number of entries, dropping clean files before unsaved content', () => {
        const clean = Array.from({ length: MAX_SESSION_ENTRIES }, (_, i) =>
            tab({ path: `/f${i}.txt`, title: `f${i}.txt`, isUntitled: false }));
        const unsaved = tab({ title: 'Untitled-1', content: 'keep me' });
        const { session, omitted } = buildSessionSnapshot([...clean, unsaved], null);
        expect(session).toHaveLength(MAX_SESSION_ENTRIES);
        expect(session.some(s => s.content === 'keep me')).toBe(true);
        expect(omitted).toEqual([]);
    });
});
