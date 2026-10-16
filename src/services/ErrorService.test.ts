/** Backend error codes are for code, not for people. */
import { describe, expect, it } from 'vitest';
import { withoutErrorCodes } from './ErrorService';

describe('withoutErrorCodes', () => {
    it('removes ZITEXT_ codes from messages', () => {
        expect(withoutErrorCodes('Failed to write file: ZITEXT_PARENT_MISSING: the folder is gone.'))
            .toBe('Failed to write file: the folder is gone.');
        expect(withoutErrorCodes('Nothing to remove')).toBe('Nothing to remove');
    });
});
