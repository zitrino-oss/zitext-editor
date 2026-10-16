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
                // A dialog that opens unprompted asks for focus on itself.
                if (activeDialog?.hasAttribute('data-focus-dialog')) {
                    activeDialog.focus();
                    return;
                }
                const preferred = activeDialog?.querySelector<HTMLElement>('[autofocus], input, button');
                (preferred ?? activeDialog)?.focus();
            });
        };

        // Escape closes the top dialog the way clicking outside it does, for
        // dialogs that don't handle Escape themselves. Runs after
        // the dialog's own handlers: a dialog that used the key (a shortcut
        // recorder, a Go to Line field that already closed) is left alone.
        // The top dialog is noted before any handler runs, so a dialog that
        // closes itself on Escape does not also close the one beneath it.
        let escapeTarget: HTMLElement | null = null;
        const noteEscapeTarget = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const overlays = Array.from(document.querySelectorAll<HTMLElement>('.modal-overlay'));
            escapeTarget = overlays[overlays.length - 1] ?? null;
        };
        const onEscape = (event: KeyboardEvent) => {
            const overlay = escapeTarget;
            escapeTarget = null;
            if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
            if (!overlay?.isConnected) return;
            event.preventDefault();
            overlay.click();
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
        window.addEventListener('keydown', noteEscapeTarget, true);
        window.addEventListener('keydown', onEscape);
        synchronize();
        return () => {
            observer.disconnect();
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keydown', noteEscapeTarget, true);
            window.removeEventListener('keydown', onEscape);
            restoreFocus?.focus();
        };
    }, []);

    return null;
}
