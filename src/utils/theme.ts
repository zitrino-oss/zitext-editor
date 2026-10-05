import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/* What the user picked. `system` defers to the OS. */
export type ThemePreference = 'light' | 'dark' | 'system';

/* What the UI actually paints. `system` is always resolved away before it
   reaches a stylesheet, so no component rule has to branch on it. */
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/* Dark is the fallback wherever matchMedia is unavailable — it matches the
   pre-paint default in public/theme-init.js, which exists to keep Windows
   WebView2 from flashing white. */
function prefersDark(): boolean {
    try {
        return window.matchMedia ? window.matchMedia(DARK_QUERY).matches : true;
    } catch {
        return true;
    }
}

/* Reads a design token's current value. For the few APIs that take a colour
   string rather than CSS — Monaco's overview ruler, canvas — so they can still
   source their colour from tokens.css instead of a literal.
   `fallback` covers the moment before the stylesheet has applied. */
export function readToken(name: string, fallback: string): string {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    } catch {
        return fallback;
    }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
    if (preference === 'light' || preference === 'dark') return preference;
    return prefersDark() ? 'dark' : 'light';
}

/* Resolves the preference and, while it is `system`, keeps following the OS
   so the app re-themes live when the user flips their desktop setting.

   The native window theme is set from here rather than by the caller, because
   the two are not independent: on Windows `set_theme(Some(..))` sets WebView2's
   preferred colour scheme, which is precisely what `prefers-color-scheme`
   reports. Pinning the window to the *resolved* theme therefore fed the answer
   back into the question — after choosing Dark, switching to System read the
   pin, resolved dark, and re-pinned dark, so System could never return to the
   real OS setting. Passing the preference through means 'system' maps to
   `set_theme(None)` on the Rust side, which clears the pin and lets the OS
   value surface again. */
export function useResolvedTheme(preference: ThemePreference): ResolvedTheme {
    const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

    useEffect(() => {
        let cancelled = false;
        setResolved(resolveTheme(preference));

        // Re-read once the pin has actually been cleared: the value read above
        // can still be the outgoing pin, since clearing it is an async IPC call.
        invoke('set_window_theme', { theme: preference })
            .catch(() => { /* platforms without a window theme API */ })
            .then(() => { if (!cancelled) setResolved(resolveTheme(preference)); });

        if (preference !== 'system') return () => { cancelled = true; };

        let media: MediaQueryList;
        try {
            if (!window.matchMedia) return () => { cancelled = true; };
            media = window.matchMedia(DARK_QUERY);
        } catch {
            return () => { cancelled = true; };
        }

        // Covers both a genuine OS change and the webview catching up with the
        // cleared pin a frame after the call above resolved.
        const onChange = (event: MediaQueryListEvent) => setResolved(event.matches ? 'dark' : 'light');
        media.addEventListener('change', onChange);
        return () => {
            cancelled = true;
            media.removeEventListener('change', onChange);
        };
    }, [preference]);

    return resolved;
}
