import { describe, expect, it } from 'vitest';
import { recoveryBaseline } from './recoveryBaseline';

// A crash-recovered dirty buffer must not silently
// overwrite a change made to the file after the crash.
describe('recoveryBaseline', () => {
    const base = { modified: 100, size: 10, hash: 'h1' };

    it('keeps the snapshot base and reports a conflict when the file changed', () => {
        const current = { modified: 300, size: 12, hash: 'h2' };
        expect(recoveryBaseline(base, current)).toEqual({ diskVersion: base, conflict: true });
    });

    it('reports a conflict when the file is gone', () => {
        expect(recoveryBaseline(base, null)).toEqual({ diskVersion: base, conflict: true });
    });

    it('uses the current version when only the mtime moved', () => {
        const current = { modified: 300, size: 10, hash: 'h1' };
        expect(recoveryBaseline(base, current)).toEqual({ diskVersion: current, conflict: false });
    });

    it('keeps the previous behaviour for snapshots written without a base version', () => {
        const current = { modified: 300, size: 12, hash: 'h2' };
        expect(recoveryBaseline(undefined, current)).toEqual({ diskVersion: current, conflict: false });
    });
});
