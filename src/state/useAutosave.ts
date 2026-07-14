import { useEffect, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
    registerAutosaveEdit,
    shouldBlockAutosaveRetry,
    type AutosaveMode,
} from './autosavePolicy';

interface UseAutosaveOptions {
    mode: AutosaveMode;
    delay: number; // milliseconds
    isDirty: boolean;
    /** The currently focused tab. In "On Focus Change" mode a change here means
     *  focus moved to another tab inside the app, which triggers a save. */
    activeTabId: string | null;
    onSave: () => Promise<boolean> | boolean;
}

export function useAutosave({ mode, delay, isDirty, activeTabId, onSave }: UseAutosaveOptions) {
    const timeoutRef = useRef<number | null>(null);
    const lastSaveTimeRef = useRef<number>(Date.now());
    const isSavingRef = useRef<boolean>(false);
    const editGenerationRef = useRef(0);
    const retryBlockedRef = useRef(false);

    // Keep refs up-to-date so the stable callbacks below always read the latest
    // values without being recreated (and thus re-subscribing) every render.
    const isDirtyRef = useRef(isDirty);
    isDirtyRef.current = isDirty;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const delayRef = useRef(delay);
    delayRef.current = delay;

    // Clear any pending timeout
    const clearPendingTimeout = useCallback(() => {
        if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    // Perform save — reads from refs so it's safe to call from any closure age.
    const performSave = useCallback(async () => {
        if (isSavingRef.current || !isDirtyRef.current || retryBlockedRef.current) {
            return;
        }

        isSavingRef.current = true;
        const startingGeneration = editGenerationRef.current;
        let succeeded = false;
        try {
            succeeded = await onSaveRef.current();
            if (succeeded) {
                lastSaveTimeRef.current = Date.now();
            }
        } catch (error) {
            console.error('Autosave failed:', error);
        } finally {
            isSavingRef.current = false;
            // A failed write must not create a permanent retry storm. A later
            // edit clears this block and schedules one fresh attempt.
            retryBlockedRef.current = shouldBlockAutosaveRetry(
                succeeded,
                startingGeneration,
                editGenerationRef.current,
            );
            // If content changed while the write was in flight, the save layer
            // intentionally leaves the tab dirty. Re-arm delayed autosave so
            // that newer revision is not stranded without another keystroke.
            if (modeRef.current === 'afterDelay' && isDirtyRef.current && !retryBlockedRef.current) {
                clearPendingTimeout();
                timeoutRef.current = window.setTimeout(() => {
                    performSave();
                }, delayRef.current);
            }
        }
    }, [clearPendingTimeout]);

    // Mode: After Delay. Called by the editor on every content edit so the timer
    // is (re)started on each keystroke — the file saves `delay` ms after the LAST
    // edit (a debounce), not `delay` ms after the first one. A no-op in other modes.
    const notifyChange = useCallback(() => {
        // Every edit releases a failure block, including in onFocusChange mode.
        // Only timer scheduling is specific to afterDelay.
        const edit = registerAutosaveEdit(modeRef.current, editGenerationRef.current);
        editGenerationRef.current = edit.generation;
        retryBlockedRef.current = false;
        if (!edit.shouldSchedule) return;
        clearPendingTimeout();
        timeoutRef.current = window.setTimeout(() => {
            performSave();
        }, delayRef.current);
    }, [clearPendingTimeout, performSave]);

    // Cancel a pending debounce as soon as autosave is turned off or switched away
    // from After Delay, so a queued save can't fire under the new mode.
    useEffect(() => {
        if (mode !== 'afterDelay') {
            clearPendingTimeout();
        }
    }, [mode, clearPendingTimeout]);

    // Mode: On Focus Change — save when the whole app window loses focus
    // (e.g. Alt-Tab to another application). performSave reads isDirtyRef, so no
    // isDirty dep is needed here.
    useEffect(() => {
        if (mode !== 'onFocusChange') {
            return;
        }

        // DOM blur — works in the browser/dev, but on Tauri it does not reliably
        // fire when the OS window loses focus, so it's only a fallback.
        const handleBlur = () => {
            performSave();
        };
        window.addEventListener('blur', handleBlur);

        // Tauri native window focus event — the reliable signal in a production
        // build. Fires with focused=false when the window loses OS focus.
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        getCurrentWindow()
            .onFocusChanged(({ payload: focused }) => {
                if (!focused) performSave();
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch(() => {
                /* Not running inside Tauri (e.g. plain browser) — DOM blur covers it. */
            });

        return () => {
            cancelled = true;
            window.removeEventListener('blur', handleBlur);
            unlisten?.();
        };
    }, [mode, performSave]);

    // Mode: On Focus Change — also save when focus moves to a different tab inside
    // the app. Window 'blur' only fires when the OS window loses focus, so without
    // this, switching tabs (the common case) would never trigger a save.
    const prevTabIdRef = useRef(activeTabId);
    useEffect(() => {
        if (mode === 'onFocusChange' && prevTabIdRef.current !== activeTabId) {
            performSave();
        }
        prevTabIdRef.current = activeTabId;
    }, [mode, activeTabId, performSave]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearPendingTimeout();
        };
    }, [clearPendingTimeout]);

    return {
        notifyChange,
        isSaving: isSavingRef.current,
        lastSaveTime: lastSaveTimeRef.current,
    };
}
