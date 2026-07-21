import { describe, expect, it } from 'vitest';
import { registerAutosaveEdit, shouldBlockAutosaveRetry } from './autosavePolicy';

describe('autosave retry policy', () => {
    it('stops a persistent failure until another edit occurs', () => {
        expect(shouldBlockAutosaveRetry(false, 4, 4)).toBe(true);
        expect(shouldBlockAutosaveRetry(false, 4, 5)).toBe(false);
        expect(shouldBlockAutosaveRetry(true, 4, 4)).toBe(false);
    });

    it('registers edits in focus-change mode without scheduling a delay', () => {
        expect(registerAutosaveEdit('onFocusChange', 7)).toEqual({
            generation: 8,
            shouldSchedule: false,
        });
    });

    it('registers and schedules edits in delayed mode', () => {
        expect(registerAutosaveEdit('afterDelay', 2)).toEqual({
            generation: 3,
            shouldSchedule: true,
        });
    });
});
