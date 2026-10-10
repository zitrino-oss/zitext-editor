/**
 * The Scratchpad's storage: one note in the app's data folder (backend
 * read_scratchpad / write_scratchpad). Saves are debounced while typing and
 * chained, so an older text can never land after a newer one; quitting
 * flushes what is pending first.
 */
import { invoke } from '@tauri-apps/api/core';
import { errorService } from '../services/ErrorService';

const SAVE_DELAY_MS = 400;
/** Quitting waits at most this long for the last save. */
const FLUSH_TIMEOUT_MS = 2000;

let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
let reportedFailure = false;

/** Why the latest text isn't saved, or null when it is. The Scratchpad shows
 *  it until a save works, and quitting asks before losing that text. */
let saveProblem: string | null = null;
const stateListeners = new Set<() => void>();

export function scratchpadSaveProblem(): string | null {
    return saveProblem;
}

export function onScratchpadSaveState(listener: () => void): () => void {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); };
}

function setSaveProblem(problem: string | null) {
    if (problem === saveProblem) return;
    saveProblem = problem;
    stateListeners.forEach(listener => listener());
}

export function scheduleScratchpadSave(text: string): void {
    pending = text;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { void flushScratchpad(); }, SAVE_DELAY_MS);
}

/** Writes any pending text now; resolves once every save so far has finished. */
export function flushScratchpad(): Promise<void> {
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
    if (pending !== null) {
        const content = pending;
        pending = null;
        chain = chain
            .then(() => invoke('write_scratchpad', { content }))
            .then(() => {
                reportedFailure = false;
                setSaveProblem(null);
            })
            .catch(error => {
                const message = error instanceof Error ? error.message : String(error);
                // Kept for the next save unless newer text is already waiting.
                if (pending === null) pending = content;
                setSaveProblem(message);
                // A toast once; the Scratchpad itself keeps showing the problem.
                if (!reportedFailure) {
                    reportedFailure = true;
                    errorService.showError('The scratchpad could not be saved', new Error(message));
                }
            });
    }
    return chain;
}

/** For quitting: the pending save, but never a hang. 'pending' means the
 *  save was still running when the wait ended (a slow or busy disk). */
export function flushScratchpadBeforeQuit(): Promise<'done' | 'pending'> {
    return Promise.race([
        flushScratchpad().then(() => 'done' as const),
        new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), FLUSH_TIMEOUT_MS)),
    ]);
}

/** The saved text (after any save still on its way). */
export async function loadScratchpad(): Promise<string> {
    await flushScratchpad();
    return invoke<string>('read_scratchpad');
}
