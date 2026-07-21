export function shouldBlockAutosaveRetry(
    succeeded: boolean,
    startingGeneration: number,
    currentGeneration: number,
): boolean {
    return !succeeded && startingGeneration === currentGeneration;
}

export type AutosaveMode = 'off' | 'afterDelay' | 'onFocusChange';

/**
 * Every edit advances the generation and releases a previous failed-save
 * block. Only delayed autosave needs to schedule a timer for that edit.
 */
export function registerAutosaveEdit(mode: AutosaveMode, currentGeneration: number) {
    return {
        generation: currentGeneration + 1,
        shouldSchedule: mode === 'afterDelay',
    };
}
