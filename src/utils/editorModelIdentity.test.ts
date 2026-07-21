import { describe, expect, it } from 'vitest';
import { modelUriForTab } from './editorModelIdentity';

describe('Monaco tab model identity', () => {
    it('assigns a unique, URI-safe model to every tab', () => {
        expect(modelUriForTab('tab-1')).not.toBe(modelUriForTab('tab-2'));
        expect(modelUriForTab('tab/with spaces')).toBe(
            'zitext://document/tab%2Fwith%20spaces',
        );
    });
});
