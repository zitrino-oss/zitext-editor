import { errorService } from '../services/ErrorService';

/**
 * Tells the user once in a while that ZITEXT could not save its own data.
 * These failures used to go only to the developer console,
 * so a full disk or a read-only settings folder went unnoticed.
 */
const REPEAT_AFTER_MS = 60_000;
const lastShown = new Map<string, number>();

export function reportPersistenceFailure(what: 'settings' | 'recent files', error: unknown): void {
    console.error(`Failed to save ${what}:`, error);
    const now = Date.now();
    if (now - (lastShown.get(what) ?? -Infinity) < REPEAT_AFTER_MS) return;
    lastShown.set(what, now);
    const message = error instanceof Error ? error.message : String(error);
    errorService.showWarning(`ZITEXT couldn't save its ${what}: ${message}`);
}
