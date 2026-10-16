/**
 * Startup handoff gate. The backend queues files and folders
 * from the command line, Finder, a second launch or drag and drop until the
 * renderer collects its startup files; anything arriving later is sent as an
 * `open-file` / `open-folder` event. Collecting before App has registered
 * those listeners would let such events go unheard, so startup waits here.
 */
let markReady: () => void = () => {};
const ready = new Promise<void>(resolve => { markReady = resolve; });

/** App calls this once its open-file and open-folder listeners exist. */
export function markOpenListenersReady(): void {
    markReady();
}

/** Resolves when the listeners exist, or after `timeoutMs` as a safety net. */
export function openListenersReady(timeoutMs = 3000): Promise<void> {
    return Promise.race([ready, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
}
