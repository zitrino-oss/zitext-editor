/**
 * Local session health tracking.
 * Records session start/end and detects crashes for the diagnostics panel.
 * Data stored in localStorage — never leaves the machine.
 */

const SESSIONS_KEY = 'session_health_log';
const MAX_SESSIONS = 50;

interface SessionRecord {
    id: string;
    start: number;       // epoch ms
    end: number | null;   // null = crash
    fileCount: number;
    errorCount: number;
}

let currentSessionId: string | null = null;
let errorCounter = 0;

export function startSession(): void {
    currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const record: SessionRecord = {
        id: currentSessionId,
        start: Date.now(),
        end: null,
        fileCount: 0,
        errorCount: 0,
    };
    const log = getLog();
    log.push(record);
    // Keep only recent sessions
    while (log.length > MAX_SESSIONS) log.shift();
    saveLog(log);
}

export function endSession(fileCount: number): void {
    if (!currentSessionId) return;
    const log = getLog();
    const session = log.find(s => s.id === currentSessionId);
    if (session) {
        session.end = Date.now();
        session.fileCount = fileCount;
        session.errorCount = errorCounter;
        saveLog(log);
    }
}

export function incrementErrorCount(): void {
    errorCounter++;
}

export interface SessionHealthSummary {
    totalSessions: number;
    crashedSessions: number;
    crashFreeRate: number;      // 0-100
    avgDurationMs: number;
    peakFileCount: number;
}

export function getHealthSummary(): SessionHealthSummary {
    const log = getLog();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = log.filter(s => s.start >= thirtyDaysAgo);

    const total = recent.length;
    const crashed = recent.filter(s => s.end === null).length;
    const completed = recent.filter(s => s.end !== null);
    const avgDuration = completed.length > 0
        ? completed.reduce((sum, s) => sum + (s.end! - s.start), 0) / completed.length
        : 0;
    const peakFiles = recent.reduce((max, s) => Math.max(max, s.fileCount), 0);

    return {
        totalSessions: total,
        crashedSessions: crashed,
        crashFreeRate: total > 0 ? Math.round(((total - crashed) / total) * 100) : 100,
        avgDurationMs: avgDuration,
        peakFileCount: peakFiles,
    };
}

function getLog(): SessionRecord[] {
    try {
        const raw = localStorage.getItem(SESSIONS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveLog(log: SessionRecord[]): void {
    try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(log));
    } catch { /* quota exceeded — non-critical */ }
}
