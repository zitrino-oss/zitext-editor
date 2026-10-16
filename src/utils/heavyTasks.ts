/**
 * Runs a HeavyTask off the UI thread, so a large format or a
 * pathological regular expression can't freeze typing and scrolling. Each
 * task gets its own worker, which a time limit can stop outright.
 */
// Type only: the task code itself runs in the worker, and is loaded here only
// where workers don't exist, so it stays out of the startup bundle.
import type { HeavyTask } from './heavyTaskRunner';

export class HeavyTaskTimeout extends Error {
    constructor() {
        super('This took too long and was stopped.');
        this.name = 'HeavyTaskTimeout';
    }
}

/** Thrown when a task's AbortSignal stops it (a newer task replaced it). */
export class HeavyTaskAborted extends Error {
    constructor() {
        super('Stopped: a newer task replaced this one.');
        this.name = 'HeavyTaskAborted';
    }
}

export async function runHeavyTaskOffThread(task: HeavyTask, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new HeavyTaskAborted();
    if (typeof Worker === 'undefined') { // tests (jsdom)
        const { runHeavyTask } = await import('./heavyTaskRunner');
        return runHeavyTask(task);
    }
    const { default: HeavyWorker } = await import('../workers/heavyTasks.worker?worker');
    const worker: Worker = new HeavyWorker();
    return new Promise<string>((resolve, reject) => {
        const timer = timeoutMs === undefined ? undefined : window.setTimeout(() => {
            worker.terminate();
            reject(new HeavyTaskTimeout());
        }, timeoutMs);
        // A superseded task is stopped outright, not left to finish.
        const abort = () => {
            finish();
            reject(new HeavyTaskAborted());
        };
        const finish = () => {
            if (timer !== undefined) window.clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            worker.terminate();
        };
        signal?.addEventListener('abort', abort);
        worker.onmessage = (event: MessageEvent<{ ok: boolean; value?: string; error?: string }>) => {
            finish();
            if (event.data.ok) resolve(event.data.value ?? '');
            else reject(new Error(event.data.error));
        };
        worker.onerror = event => {
            finish();
            reject(new Error(event.message || 'Background task failed'));
        };
        worker.postMessage(task);
    });
}

/** False where background workers don't exist (tests), so the regex check is skipped. */
export function regexGuardAvailable(): boolean {
    return typeof Worker !== 'undefined';
}

/** How long a Find regular expression may take on the document. */
const REGEX_TIME_LIMIT_MS = 1500;

/**
 * 'slow' when the pattern doesn't finish on this text within the limit
 * (catastrophic backtracking such as `(a+)+$`), so the caller refuses it
 * instead of freezing the window. An invalid pattern counts as 'ok': the
 * caller reports invalid patterns itself.
 */
export async function checkRegexSpeed(pattern: string, flags: string, text: string, timeLimitMs = REGEX_TIME_LIMIT_MS, allMatches = false): Promise<'ok' | 'slow'> {
    try {
        await runHeavyTaskOffThread({ kind: 'regexRun', pattern, flags, text, allMatches }, timeLimitMs);
        return 'ok';
    } catch (error) {
        return error instanceof HeavyTaskTimeout ? 'slow' : 'ok';
    }
}
