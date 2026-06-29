import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';

let appVersion = 'unknown';
const platform = navigator.platform;

/**
 * Initializes global error handlers that capture unhandled errors and
 * promise rejections, then write them to a local crash.log file via the backend.
 */
export async function initCrashReporter(): Promise<void> {
    try {
        appVersion = await getVersion();
    } catch { /* use fallback */ }

    window.addEventListener('error', (event) => {
        writeEntry({
            level: 'error',
            source: 'js',
            message: event.message || 'Unknown error',
            stack: event.error?.stack,
            file: event.filename,
            line: event.lineno,
            col: event.colno,
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        writeEntry({
            level: 'error',
            source: 'unhandledrejection',
            message: reason?.message || String(reason),
            stack: reason?.stack,
        });
    });
}

interface LogEntry {
    level: string;
    source: string;
    message: string;
    stack?: string;
    file?: string;
    line?: number;
    col?: number;
}

const MAX_MESSAGE_LEN = 1000;
const MAX_STACK_LEN = 4000;

/**
 * Redacts absolute filesystem paths (which can embed usernames and, via error
 * messages, fragments of file content) and truncates long strings before the
 * entry is written to the local crash.log. The log never leaves the device,
 * but users sometimes share it for support, so we minimize what it captures.
 */
function scrub(text: string | undefined, maxLen: number): string | undefined {
    if (!text) return text;
    let out = text
        .replace(/\/Users\/[^/\s]+/g, '/Users/<user>')      // macOS
        .replace(/\/home\/[^/\s]+/g, '/home/<user>')        // Linux
        .replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, 'C:\\Users\\<user>'); // Windows
    if (out.length > maxLen) out = out.slice(0, maxLen) + '…[truncated]';
    return out;
}

function writeEntry(entry: LogEntry): void {
    const scrubbed: LogEntry = {
        ...entry,
        message: scrub(entry.message, MAX_MESSAGE_LEN) ?? entry.message,
        stack: scrub(entry.stack, MAX_STACK_LEN),
        file: scrub(entry.file, MAX_MESSAGE_LEN),
    };
    const record = JSON.stringify({
        ts: new Date().toISOString(),
        version: appVersion,
        os: platform,
        ...scrubbed,
    });

    // Fire-and-forget — crash logging must never block the UI
    invoke('append_crash_log', { line: record }).catch(() => {
        // If the backend command fails, fall back to console
        console.error('[crash-reporter]', record);
    });
}
