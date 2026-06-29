import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

const CHECK_URL = 'https://zitext.com/api/latest';
const DISMISSED_KEY_PREFIX = 'update_dismissed_v';
const SKIPPED_KEY_PREFIX = 'update_skipped_v';

export interface UpdateInfo {
    version: string;
    releaseDate: string;
}

/**
 * Checks zitext.com/api/latest once per session on mount.
 * Respects the `enabled` flag — when false, no network call is made.
 * Returns the new version info if one is available and not yet dismissed,
 * plus a `dismiss()` function that persists the decision in localStorage.
 */
export function useUpdateChecker(enabled: boolean = true): { update: UpdateInfo | null; dismiss: () => void } {
    const [update, setUpdate] = useState<UpdateInfo | null>(null);

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        // Small startup delay so the check doesn't compete with initial file loading
        const delay = setTimeout(() => runCheck(controller.signal), 3000);
        return () => { clearTimeout(delay); controller.abort(); };
    }, [enabled]);

    async function runCheck(signal: AbortSignal) {
        try {
            const [res, currentVersion] = await Promise.all([
                fetch(CHECK_URL, { signal }),
                getVersion(),
            ]);
            if (!res.ok) return;
            const manifest = await res.json();
            const latest: string = manifest?.version;
            if (!latest || typeof latest !== 'string') return;

            // Suppress the prompt if the user already chose Skip This Version
            // (persists across sessions) or dismissed for this session.
            if (
                localStorage.getItem(`${SKIPPED_KEY_PREFIX}${latest}`) ||
                localStorage.getItem(`${DISMISSED_KEY_PREFIX}${latest}`)
            ) return;

            if (isNewer(latest, currentVersion)) {
                setUpdate({ version: latest, releaseDate: manifest.releaseDate ?? '' });
            }
        } catch {
            // Network errors are silent — update checks are best-effort
        }
    }

    function dismiss() {
        if (update) {
            localStorage.setItem(`${DISMISSED_KEY_PREFIX}${update.version}`, '1');
        }
        setUpdate(null);
    }

    return { update, dismiss };
}

/** Returns true if `candidate` is a strictly higher semver than `current`. */
function isNewer(candidate: string, current: string): boolean {
    // Compare only the numeric release part: strip a leading "v", drop build
    // metadata ("+...") and pre-release suffixes ("-rc1"), then compare each
    // dotted segment numerically. Handles versions with differing segment
    // counts (e.g. "1.2" vs "1.2.0") instead of assuming exactly three parts.
    const parse = (v: string) =>
        v.trim()
            .replace(/^v/i, '')
            .split('+')[0]
            .split('-')[0]
            .split('.')
            .map(n => {
                const x = parseInt(n, 10);
                return Number.isFinite(x) ? x : 0;
            });
    const a = parse(candidate);
    const b = parse(current);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        if (av !== bv) return av > bv;
    }
    return false;
}
