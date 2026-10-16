/// <reference lib="webworker" />
import { runHeavyTask, type HeavyTask } from '../utils/heavyTaskRunner';

self.onmessage = (event: MessageEvent<HeavyTask>) => {
    try {
        self.postMessage({ ok: true, value: runHeavyTask(event.data) });
    } catch (error) {
        self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
