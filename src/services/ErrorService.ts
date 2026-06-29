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

interface Toast {
    id: string;
    type: ToastType;
    message: string;
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
        const fullMessage = error
            ? `${message}: ${error.message}`
            : message;

        this.addToast('error', fullMessage, duration);

        // Log to console in development
        if (import.meta.env.DEV) {
            console.error(message, error);
        }
    }

    /**
     * Show a warning notification
     */
    showWarning(message: string, duration: number = TOAST_WARNING_DURATION_MS): void {
        this.addToast('warning', message, duration);

        if (import.meta.env.DEV) {
            console.warn(message);
        }
    }

    /**
     * Show a success notification
     */
    showSuccess(message: string, duration: number = TOAST_SUCCESS_DURATION_MS): void {
        this.addToast('success', message, duration);
    }

    /**
     * Show an info notification
     */
    showInfo(message: string, duration: number = TOAST_INFO_DURATION_MS): void {
        this.addToast('info', message, duration);
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
    private addToast(type: ToastType, message: string, duration: number): void {
        const id = `toast-${++this.toastCounter}-${Date.now()}`;
        const toast: Toast = { id, type, message, duration };

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
