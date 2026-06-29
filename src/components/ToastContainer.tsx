import { useState, useEffect } from 'react';
import { errorService, type ToastType } from '../services/ErrorService';
import '../styles/ToastContainer.css';

interface Toast {
    id: string;
    type: ToastType;
    message: string;
    duration: number;
}

export function ToastContainer() {
    const [toasts, setToasts] = useState<Toast[]>([]);

    useEffect(() => {
        const unsubscribe = errorService.subscribe(setToasts);
        return unsubscribe;
    }, []);

    const handleClose = (id: string) => {
        errorService.removeToast(id);
    };

    if (toasts.length === 0) {
        return null;
    }

    return (
        <div className="toast-container">
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    className={`toast toast-${toast.type}`}
                    role="alert"
                >
                    <div className="toast-icon">
                        {getIcon(toast.type)}
                    </div>
                    <div className="toast-message">{toast.message}</div>
                    <button
                        className="toast-close"
                        onClick={() => handleClose(toast.id)}
                        aria-label="Close notification"
                    >
                        ✕
                    </button>
                </div>
            ))}
        </div>
    );
}

function getIcon(type: ToastType): string {
    switch (type) {
        case 'error': return '❌';
        case 'warning': return '⚠️';
        case 'success': return '✅';
        case 'info': return 'ℹ️';
        default: return 'ℹ️';
    }
}
