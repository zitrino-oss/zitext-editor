import { describe, expect, it } from 'vitest';
import { KeyedTaskQueue } from './keyedTaskQueue';

describe('KeyedTaskQueue', () => {
    it('runs every same-key request in FIFO order', async () => {
        const queue = new KeyedTaskQueue();
        const order: string[] = [];
        let currentContent = 'C1';
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

        const first = queue.enqueue('tab-1', async () => {
            order.push('first:start');
            await firstGate;
            order.push('first:end');
            return 'first';
        });
        const second = queue.enqueue('tab-1', async () => {
            order.push('second');
            return currentContent;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(['first:start']);
        currentContent = 'C2';
        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toEqual(['first', 'C2']);
        expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    it('continues after a failed task and does not serialize different keys', async () => {
        const queue = new KeyedTaskQueue();
        const failed = queue.enqueue('tab-1', async () => { throw new Error('write failed'); });
        const recovered = queue.enqueue('tab-1', async () => 'saved');
        const otherTab = queue.enqueue('tab-2', async () => 'parallel');

        await expect(failed).rejects.toThrow('write failed');
        await expect(Promise.all([recovered, otherTab])).resolves.toEqual(['saved', 'parallel']);
    });
});
