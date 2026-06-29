/**
 * Lightweight performance measurement utility.
 * Uses performance.mark() / performance.measure() under the hood.
 * Metrics are stored in-memory and logged to console in dev mode.
 */

const metrics: Record<string, number[]> = {};

export function startTimer(label: string): void {
    try {
        performance.mark(`${label}-start`);
    } catch { /* ignore in environments without performance API */ }
}

export function endTimer(label: string): number {
    try {
        performance.mark(`${label}-end`);
        const measure = performance.measure(label, `${label}-start`, `${label}-end`);
        const duration = measure.duration;

        if (!metrics[label]) metrics[label] = [];
        metrics[label].push(duration);

        if (import.meta.env.DEV) {
            console.log(`[perf] ${label}: ${duration.toFixed(1)}ms`);
        }

        // Clean up marks
        performance.clearMarks(`${label}-start`);
        performance.clearMarks(`${label}-end`);
        performance.clearMeasures(label);

        return duration;
    } catch {
        return 0;
    }
}

export function getMetrics(): Record<string, { count: number; avg: number; min: number; max: number }> {
    const result: Record<string, { count: number; avg: number; min: number; max: number }> = {};
    for (const [label, times] of Object.entries(metrics)) {
        if (times.length === 0) continue;
        result[label] = {
            count: times.length,
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            min: Math.min(...times),
            max: Math.max(...times),
        };
    }
    return result;
}

export function logMetricsSummary(): void {
    const m = getMetrics();
    if (Object.keys(m).length > 0) {
        console.table(m);
    }
}
