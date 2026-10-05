/**
 * ErrorService - Centralized error handling and user notifications
 * 
 * Replaces scattered alert() calls with a consistent, non-intrusive
 * toast notification system.
 */

import {
    TOAST_ERROR_DURATION_MS,
    TOAST_WARNING_DURATION_MS,
    TOAST_SUCCESS_DURATION_MS,
    TOAST_INFO_DURATION_MS,
} from '../constants';

export type ToastType = 'error' | 'warning' | 'success' | 'info';

export interface Toast {
    id: string;
    type: ToastType;
    /** Headline. Kept short — it is the bold first line. */
    message: string;
    /** Optional second line: the cause, path or figure behind the headline. */
    detail?: string;
    /** Renders the detail in the mono face, for machine text like error codes. */
    detailMono?: boolean;
    duration: number;
}

class ErrorService {
    private toasts: Toast[] = [];
    private listeners: Set<(toasts: Toast[]) => void> = new Set();
    private toastCounter = 0;

    /**
     * Show an error notification
     */
    showError(message: string, error?: Error, duration: number = TOAST_ERROR_DURATION_MS): void {
        this.addToast('error', message, duration, error?.message, true);

        // Log to console in development
        if (import.meta.env.DEV) {
            console.error(message, error);
        }
    }

    /**
     * Show a warning notification
     */
    showWarning(message: string, duration: number = TOAST_WARNING_DURATION_MS, detail?: string): void {
        this.addToast('warning', message, duration, detail);

        if (import.meta.env.DEV) {
            console.warn(message);
        }
    }

    /**
     * Show a success notification
     */
    showSuccess(message: string, duration: number = TOAST_SUCCESS_DURATION_MS, detail?: string): void {
        this.addToast('success', message, duration, detail);
    }

    /**
     * Show an info notification
     */
    showInfo(message: string, duration: number = TOAST_INFO_DURATION_MS, detail?: string): void {
        this.addToast('info', message, duration, detail);
    }

    /**
     * Subscribe to toast updates
     */
    subscribe(listener: (toasts: Toast[]) => void): () => void {
        this.listeners.add(listener);
        listener(this.toasts);

        // Return unsubscribe function
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Remove a toast by ID
     */
    removeToast(id: string): void {
        this.toasts = this.toasts.filter(t => t.id !== id);
        this.notifyListeners();
    }

    /**
     * Add a new toast
     */
    private addToast(type: ToastType, message: string, duration: number, detail?: string, detailMono = false): void {
        const id = `toast-${++this.toastCounter}-${Date.now()}`;
        const toast: Toast = { id, type, message, detail, detailMono, duration };

        this.toasts.push(toast);
        this.notifyListeners();

        // Auto-remove after duration
        if (duration > 0) {
            setTimeout(() => {
                this.removeToast(id);
            }, duration);
        }
    }

    /**
     * Notify all listeners of toast changes
     */
    private notifyListeners(): void {
        this.listeners.forEach(listener => listener([...this.toasts]));
    }
}

// Singleton instance
export const errorService = new ErrorService();
