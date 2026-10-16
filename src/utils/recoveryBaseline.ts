import type { DiskVersion } from '../types';

export interface RecoveryBaseline {
    /** Version the restored tab should treat as "what is on disk". */
    diskVersion: DiskVersion | null;
    /** True when the file changed after the snapshot was taken. */
    conflict: boolean;
}

/**
 * Decides the conflict baseline for a crash-recovered dirty buffer.
 *
 * The recovered text was written against `base` (the version on disk when
 * the snapshot was taken). If the file now differs, the tab must keep `base`
 * as its expected version so the next save hits the normal conflict check,
 * instead of silently overwriting a change made after the crash.
 *
 * Content identity (hash + size) decides "unchanged": a file whose bytes are
 * identical but whose mtime moved is safe, and gets the current version so
 * an ordinary save passes the backend's version check.
 *
 * Snapshots written before base versions existed (`base` undefined) keep the
 * previous behaviour of using the current disk version, since there is
 * nothing to compare against.
 */
export function recoveryBaseline(
    base: DiskVersion | undefined,
    current: DiskVersion | null,
): RecoveryBaseline {
    if (!base) return { diskVersion: current, conflict: false };
    if (current && current.hash === base.hash && current.size === base.size) {
        return { diskVersion: current, conflict: false };
    }
    return { diskVersion: base, conflict: true };
}
