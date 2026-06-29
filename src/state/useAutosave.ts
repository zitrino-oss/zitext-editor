import { useEffect, useRef, useCallback } from 'react';

type AutosaveMode = 'off' | 'afterDelay' | 'onFocusChange';

interface UseAutosaveOptions {
    mode: AutosaveMode;
    delay: number; // milliseconds
    isDirty: boolean;
    onSave: () => Promise<void> | void;
}

export function useAutosave({ mode, delay, isDirty, onSave }: UseAutosaveOptions) {
    const timeoutRef = useRef<number | null>(null);
    const lastSaveTimeRef = useRef<number>(Date.now());
    const isSavingRef = useRef<boolean>(false);

    // Keep refs up-to-date so performSave always uses the latest values
    // without needing to be recreated on every render.
    const isDirtyRef = useRef(isDirty);
    isDirtyRef.current = isDirty;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;

    // Clear any pending timeout
    const clearPendingTimeout = useCallback(() => {
        if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }
    }, []);

    // Perform save — reads from refs so it's safe to call from any closure age.
    const performSave = useCallback(async () => {
        if (isSavingRef.current || !isDirtyRef.current) {
            return;
        }

        isSavingRef.current = true;
        try {
            await onSaveRef.current();
            lastSaveTimeRef.current = Date.now();
        } catch (error) {
            console.error('Autosave failed:', error);
        } finally {
            isSavingRef.current = false;
        }
    }, []); // stable — no prop deps; uses refs instead

    // Mode: After Delay — reschedule whenever dirty state or delay changes.
    useEffect(() => {
        if (mode !== 'afterDelay' || !isDirty) {
            clearPendingTimeout();
            return;
        }

        clearPendingTimeout();
        timeoutRef.current = window.setTimeout(() => {
            performSave();
        }, delay);

        return () => {
            clearPendingTimeout();
        };
    }, [mode, delay, isDirty, performSave, clearPendingTimeout]);

    // Mode: On Focus Change — performSave reads isDirtyRef so no isDirty dep needed.
    useEffect(() => {
        if (mode !== 'onFocusChange') {
            return;
        }

        const handleBlur = () => {
            performSave();
        };

        window.addEventListener('blur', handleBlur);
        return () => {
            window.removeEventListener('blur', handleBlur);
        };
    }, [mode, performSave]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearPendingTimeout();
        };
    }, [clearPendingTimeout]);

    return {
        isSaving: isSavingRef.current,
        lastSaveTime: lastSaveTimeRef.current,
    };
}
