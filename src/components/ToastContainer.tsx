import { useState, useEffect } from 'react';
import { errorService, type Toast, type ToastType } from '../services/ErrorService';
import '../styles/ToastContainer.css';

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
                    <div className="toast-icon" aria-hidden="true">
                        {getIcon(toast.type)}
                    </div>
                    <div className="toast-text">
                        <span className="toast-message">{toast.message}</span>
                        {toast.detail && (
                            <span className={`toast-detail${toast.detailMono ? ' mono' : ''}`}>
                                {toast.detail}
                            </span>
                        )}
                    </div>
                    <button
                        className="toast-close"
                        onClick={() => handleClose(toast.id)}
                        aria-label="Close notification"
                    >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            ))}
        </div>
    );
}

/* Inline SVG rather than glyphs like ✕ / ✓ — those sit outside the bundled
   font subset and would fall back to an OS font (tofu on bare Linux). */
function getIcon(type: ToastType) {
    const props = {
        width: 11,
        height: 11,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
    };

    switch (type) {
        case 'error':
            return (
                <svg {...props} strokeWidth={2.6}>
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            );
        case 'warning':
            return (
                <svg {...props} strokeWidth={2.6}>
                    <line x1="12" y1="7" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" />
                </svg>
            );
        case 'success':
            return (
                <svg {...props} strokeWidth={3}>
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            );
        default:
            return (
                <svg {...props} strokeWidth={2.6}>
                    <line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="7" x2="12" y2="7" />
                </svg>
            );
    }
}
