import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

const CHECK_URL = 'https://zitext.com/api/latest';
const SKIPPED_KEY_PREFIX = 'update_skipped_v';
// Older builds stored "Remind me later" here, which hid that version for good.
const LEGACY_DISMISSED_KEY_PREFIX = 'update_dismissed_v';
const CHECK_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface UpdateInfo {
    version: string;
    releaseDate: string;
}

// "Later" lasts for this run of the app only.
const dismissedThisSession = new Set<string>();

function storage(): Storage | null {
    try { return window.localStorage; } catch { return null; }
}

/** Remembers "Skip this version" across sessions. */
export function skipUpdateVersion(version: string): void {
    try { storage()?.setItem(`${SKIPPED_KEY_PREFIX}${version}`, '1'); } catch { /* best effort */ }
}

function isSkipped(version: string): boolean {
    try { return !!storage()?.getItem(`${SKIPPED_KEY_PREFIX}${version}`); } catch { return false; }
}

function forgetLegacyDismissals(): void {
    const store = storage();
    if (!store) return;
    try {
        for (let i = store.length - 1; i >= 0; i--) {
            const key = store.key(i);
            if (key?.startsWith(LEGACY_DISMISSED_KEY_PREFIX)) store.removeItem(key);
        }
    } catch { /* best effort */ }
}

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/**
 * Strict SemVer 2.0 precedence: -1, 0 or 1, or null when either string is
 * not a version. Pre-releases sort before their release, so moving from
 * 2.2.0-rc.1 to 2.2.0 is an update.
 */
export function compareVersions(a: string, b: string): number | null {
    const pa = SEMVER.exec(a.trim());
    const pb = SEMVER.exec(b.trim());
    if (!pa || !pb) return null;
    for (let i = 1; i <= 3; i++) {
        const diff = Number(pa[i]) - Number(pb[i]);
        if (diff !== 0) return Math.sign(diff);
    }
    const preA = pa[4];
    const preB = pb[4];
    if (preA === preB) return 0;
    if (preA === undefined) return 1;
    if (preB === undefined) return -1;
    const idsA = preA.split('.');
    const idsB = preB.split('.');
    for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
        const x = idsA[i];
        const y = idsB[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            const diff = Number(x) - Number(y);
            if (diff !== 0) return Math.sign(diff);
        } else if (nx !== ny) {
            return nx ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/** Reads the manifest defensively: bounded size, expected field types. */
export function parseManifest(text: string): UpdateInfo | null {
    if (text.length > MAX_MANIFEST_BYTES) return null;
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { return null; }
    if (!manifest || typeof manifest !== 'object') return null;
    const { version, releaseDate } = manifest as Record<string, unknown>;
    if (typeof version !== 'string' || !SEMVER.test(version.trim())) return null;
    return {
        version: version.trim(),
        releaseDate: typeof releaseDate === 'string' && releaseDate.length <= 40 ? releaseDate : '',
    };
}

/**
 * Checks zitext.com/api/latest once per session on mount.
 * Respects the `enabled` flag — when false, no network call is made.
 * Returns the new version, if any, unless it was skipped for good or put off
 * for this session; `dismiss` puts it off for this session, `skip` for good.
 */
export function useUpdateChecker(enabled: boolean = true): { update: UpdateInfo | null; dismiss: () => void; skip: () => void } {
    const [update, setUpdate] = useState<UpdateInfo | null>(null);

    useEffect(() => {
        if (!enabled) return;
        forgetLegacyDismissals();
        const controller = new AbortController();
        // Small startup delay so the check doesn't compete with initial file loading
        const delay = setTimeout(() => runCheck(controller.signal), 3000);
        const timeout = setTimeout(() => controller.abort(), 3000 + CHECK_TIMEOUT_MS);
        return () => { clearTimeout(delay); clearTimeout(timeout); controller.abort(); };
    }, [enabled]);

    async function runCheck(signal: AbortSignal) {
        try {
            const [res, currentVersion] = await Promise.all([
                fetch(CHECK_URL, { signal }),
                getVersion(),
            ]);
            if (!res.ok) return;
            const declared = Number(res.headers.get('content-length') ?? 0);
            if (declared > MAX_MANIFEST_BYTES) return;
            const latest = parseManifest(await res.text());
            if (!latest) return;
            if (isSkipped(latest.version) || dismissedThisSession.has(latest.version)) return;
            if (compareVersions(latest.version, currentVersion) === 1) setUpdate(latest);
        } catch {
            // Network errors are silent — update checks are best-effort
        }
    }

    function dismiss() {
        if (update) dismissedThisSession.add(update.version);
        setUpdate(null);
    }

    function skip() {
        if (update) skipUpdateVersion(update.version);
        setUpdate(null);
    }

    return { update, dismiss, skip };
}
