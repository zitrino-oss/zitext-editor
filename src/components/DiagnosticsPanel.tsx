import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { getHealthSummary, type SessionHealthSummary } from '../utils/sessionHealth';
import { getMetrics } from '../utils/perfMetrics';

interface DiagnosticsPanelProps {
    isOpen: boolean;
    onClose: () => void;
    tabCount: number;
    theme: 'light' | 'dark';
}

export function DiagnosticsPanel({ isOpen, onClose, tabCount, theme }: DiagnosticsPanelProps) {
    const [version, setVersion] = useState('');
    const [health, setHealth] = useState<SessionHealthSummary | null>(null);
    const [perfData, setPerfData] = useState<Record<string, { count: number; avg: number; min: number; max: number }>>({});

    useEffect(() => {
        if (!isOpen) return;
        getVersion().then(setVersion).catch(() => setVersion('unknown'));
        setHealth(getHealthSummary());
        setPerfData(getMetrics());
    }, [isOpen]);

    if (!isOpen) return null;

    const formatDuration = (ms: number) => {
        if (ms < 1000) return `${Math.round(ms)}ms`;
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.round(ms / 60_000)}min`;
    };

    const handleCopyDiagnostics = () => {
        const lines = [
            `ZITEXT Editor v${version}`,
            `Platform: ${navigator.platform}`,
            `User Agent: ${navigator.userAgent}`,
            `Open Tabs: ${tabCount}`,
            '',
            'Session Health (last 30 days):',
            health ? `  Total sessions: ${health.totalSessions}` : '',
            health ? `  Crash-free rate: ${health.crashFreeRate}%` : '',
            health ? `  Avg session duration: ${formatDuration(health.avgDurationMs)}` : '',
            '',
            'Performance Metrics:',
            ...Object.entries(perfData).map(([k, v]) =>
                `  ${k}: avg=${v.avg.toFixed(1)}ms, min=${v.min.toFixed(1)}ms, max=${v.max.toFixed(1)}ms (${v.count} samples)`
            ),
        ].filter(Boolean).join('\n');

        navigator.clipboard.writeText(lines).catch(console.error);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className={`modal diagnostics-modal ${theme}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h3>Diagnostics</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                <div className="modal-body">
                    <div className="settings-info">
                        <h4>System</h4>
                        <p><strong>Version:</strong> {version}</p>
                        <p><strong>Platform:</strong> {navigator.platform}</p>
                        <p><strong>Open Tabs:</strong> {tabCount}</p>
                    </div>

                    {health && (
                        <div className="settings-info">
                            <h4>Session Health (last 30 days)</h4>
                            <p><strong>Total sessions:</strong> {health.totalSessions}</p>
                            <p><strong>Crash-free rate:</strong> {health.crashFreeRate}%</p>
                            <p><strong>Avg session duration:</strong> {formatDuration(health.avgDurationMs)}</p>
                            <p><strong>Peak open files:</strong> {health.peakFileCount}</p>
                        </div>
                    )}

                    {Object.keys(perfData).length > 0 && (
                        <div className="settings-info">
                            <h4>Performance</h4>
                            {Object.entries(perfData).map(([label, data]) => (
                                <p key={label}>
                                    <strong>{label}:</strong> avg {data.avg.toFixed(1)}ms (min {data.min.toFixed(1)}, max {data.max.toFixed(1)}, {data.count}x)
                                </p>
                            ))}
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="modal-button" onClick={handleCopyDiagnostics}>Copy to Clipboard</button>
                    <button className="modal-button primary" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
