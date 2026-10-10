/** Background tasks and stale results. */
import { describe, expect, it } from 'vitest';
import { runHeavyTask } from './heavyTaskRunner';
import { applyDataTransformAsync } from './dataTransform';

describe('runHeavyTask', () => {
    it('runs the data tools and counts regex matches (including empty ones)', () => {
        expect(runHeavyTask({ kind: 'formatJson', text: '{"a":1}', indent: 4 })).toBe('{\n    "a": 1\n}');
        expect(runHeavyTask({ kind: 'minifyJson', text: '{ "a" : 1 }' })).toBe('{"a":1}');
        expect(runHeavyTask({ kind: 'regexRun', pattern: 'o', flags: 'g', text: 'foo boo' })).toBe('4');
        expect(runHeavyTask({ kind: 'regexRun', pattern: 'x*', flags: '', text: 'abc' })).toBe('4');
    });
});

describe('applyDataTransformAsync', () => {
    it('drops a result when the document changed while it was computed', async () => {
        let current = '{"a":1}';
        const result = await applyDataTransformAsync(
            { content: current, isReadOnly: false },
            async text => { current = '{"a":1} typed meanwhile'; return text.replace('1', '2'); },
            () => current,
        );
        expect(result.kind).toBe('stale');
    });

    it('applies it otherwise, keeping the line endings', async () => {
        const result = await applyDataTransformAsync(
            { content: 'a: 1\r\n', isReadOnly: false },
            async () => 'a: 2\n',
            () => 'a: 1\r\n',
        );
        expect(result).toEqual({ kind: 'changed', content: 'a: 2\r\n' });
    });
});

describe('stopping a background task', () => {
    it('refuses a task whose signal was already aborted (a newer one replaced it)', async () => {
        const { HeavyTaskAborted, runHeavyTaskOffThread } = await import('./heavyTasks');
        const controller = new AbortController();
        controller.abort();
        await expect(runHeavyTaskOffThread({ kind: 'minifyJson', text: '{}' }, undefined, controller.signal))
            .rejects.toBeInstanceOf(HeavyTaskAborted);
    });

    it('counts every match when asked to (a mark runs over the whole text)', () => {
        const text = 'a'.repeat(30_000);
        expect(runHeavyTask({ kind: 'regexRun', pattern: 'a', flags: 'g', text })).toBe('20000');
        expect(runHeavyTask({ kind: 'regexRun', pattern: 'a', flags: 'g', text, allMatches: true })).toBe('30000');
    });
});
