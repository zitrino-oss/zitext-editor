import { useEffect } from 'react';

const FOCUSABLE = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export function DialogFocusManager() {
    useEffect(() => {
        let activeDialog: HTMLElement | null = null;
        let restoreFocus: HTMLElement | null = null;

        const findDialog = (): HTMLElement | null => {
            const overlays = Array.from(
                document.querySelectorAll<HTMLElement>('.modal-overlay, .cp-overlay'),
            );
            const overlay = overlays[overlays.length - 1];
            return (overlay?.firstElementChild as HTMLElement | null) ?? overlay ?? null;
        };

        const synchronize = () => {
            const next = findDialog();
            if (next === activeDialog) return;

            if (!next) {
                activeDialog = null;
                restoreFocus?.focus();
                restoreFocus = null;
                return;
            }

            if (!activeDialog) {
                restoreFocus = document.activeElement instanceof HTMLElement
                    ? document.activeElement
                    : null;
            }
            activeDialog = next;
            activeDialog.setAttribute('role', 'dialog');
            activeDialog.setAttribute('aria-modal', 'true');
            activeDialog.setAttribute('tabindex', '-1');

            const heading = activeDialog.querySelector<HTMLElement>('h1, h2, h3');
            if (heading) {
                if (!heading.id) {
                    heading.id = `dialog-title-${Math.random().toString(36).slice(2)}`;
                }
                activeDialog.setAttribute('aria-labelledby', heading.id);
            }

            requestAnimationFrame(() => {
                const preferred = activeDialog?.querySelector<HTMLElement>('[autofocus], input, button');
                (preferred ?? activeDialog)?.focus();
            });
        };

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Tab' || !activeDialog) return;
            const focusable = Array.from(activeDialog.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (focusable.length === 0) {
                event.preventDefault();
                activeDialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        const observer = new MutationObserver(synchronize);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('keydown', onKeyDown, true);
        synchronize();
        return () => {
            observer.disconnect();
            document.removeEventListener('keydown', onKeyDown, true);
            restoreFocus?.focus();
        };
    }, []);

    return null;
}
