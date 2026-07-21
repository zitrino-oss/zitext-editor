import { describe, expect, it } from 'vitest';
import { isSavedRevisionCurrent } from './useTabManager';

describe('save revision guard', () => {
    it('clears dirty only for the exact revision that was written', () => {
        expect(isSavedRevisionCurrent(7, 7)).toBe(true);
        expect(isSavedRevisionCurrent(8, 7)).toBe(false);
        expect(isSavedRevisionCurrent(6, 7)).toBe(false);
    });
});
