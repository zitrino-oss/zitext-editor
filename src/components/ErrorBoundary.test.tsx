// @vitest-environment jsdom
/**
 * While the root error screen is shown, App's
 * close listener is gone but the backend still holds every close request.
 * The error screen must answer it (keeping the recovery snapshot).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
    invoke: vi.fn(async () => undefined),
    handlers: new Map<string, (event: { payload: string }) => void>(),
    closeWindow: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: tauri.closeWindow }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async (name: string, handler: (event: { payload: string }) => void) => {
        tauri.handlers.set(name, handler);
        return () => tauri.handlers.delete(name);
    }),
}));
vi.mock('../services/ErrorService', () => ({ errorService: { showError: vi.fn() } }));

import { ErrorBoundary } from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Crash(): never {
    throw new Error('app crashed');
}

afterEach(() => { vi.restoreAllMocks(); });

describe('root ErrorBoundary', () => {
    it('lets the window close, keeping the crash-recovery session', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const root = createRoot(document.createElement('div'));
        act(() => root.render(<ErrorBoundary><Crash /></ErrorBoundary>));
        await act(async () => { await Promise.resolve(); });

        const onClose = tauri.handlers.get('close-requested');
        expect(onClose).toBeDefined();
        onClose!({ payload: 'token-1' });
        expect(tauri.invoke).toHaveBeenCalledWith('acknowledge_close_request', { token: 'token-1' });
        expect(tauri.invoke).toHaveBeenCalledWith('confirm_app_close', { token: 'token-1', keepSession: true });

        act(() => root.unmount());
        expect(tauri.handlers.has('close-requested')).toBe(false);
    });

    it('offers a Close button (Windows has no native window controls)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(<ErrorBoundary><Crash /></ErrorBoundary>));
        const close = [...host.querySelectorAll('button')].find(b => b.textContent === 'Close ZITEXT');
        expect(close).toBeDefined();
        act(() => close!.click());
        expect(tauri.closeWindow).toHaveBeenCalled();
        act(() => root.unmount());
    });
});
