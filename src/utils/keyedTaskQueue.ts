/**
 * Serializes asynchronous work per key while allowing unrelated keys to run
 * concurrently. Every caller gets the result of its own task; requests are
 * never folded into an already-running operation.
 */
export class KeyedTaskQueue {
    private readonly tails = new Map<string, Promise<void>>();

    enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const predecessor = this.tails.get(key) ?? Promise.resolve();
        const operation = predecessor.catch(() => undefined).then(task);
        const tail = operation.then(() => undefined, () => undefined);

        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        });

        return operation;
    }
}
