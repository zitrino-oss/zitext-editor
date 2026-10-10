/* Font choices offered in Settings. Option values must never equal one of
   the superseded default stacks in useSettingsManager: those are replaced by
   the current default when settings load, which made picking Menlo, IBM Plex
   Mono or IBM Plex Sans revert on every restart. */

/* Chrome typefaces, all bundled in public/fonts.css. Space Grotesk is the
   default; the earlier defaults stay selectable rather than being dropped. */
export const UI_FONTS = [
    { value: '"Space Grotesk", system-ui, sans-serif', label: 'Space Grotesk' },
    { value: '"Geist", system-ui, sans-serif', label: 'Geist Sans' },
    // Not the old default stack string: that one is migrated on load.
    { value: '"IBM Plex Sans", "Segoe UI", "Arial", sans-serif', label: 'IBM Plex Sans' },
    { value: '"Inter", system-ui, sans-serif', label: 'Inter' },
    { value: 'system-ui, sans-serif', label: 'System UI' },
];

export const FONT_FAMILIES = [
    { value: '"IBM Plex Mono", "Cascadia Mono", "Consolas", monospace', label: 'IBM Plex Mono' },
    { value: '"Consolas", "Courier New", monospace', label: 'Consolas' },
    { value: '"Courier New", Courier, monospace', label: 'Courier New' },
    { value: '"Menlo", Consolas, "JetBrains Mono", monospace', label: 'Menlo' },
    { value: '"Monaco", "Menlo", "Courier New", monospace', label: 'Monaco' },
    { value: '"JetBrains Mono", "Menlo", "Monaco", "Consolas", monospace', label: 'JetBrains Mono' },
    { value: '"Fira Code", "Menlo", "Monaco", "Consolas", monospace', label: 'Fira Code' },
    { value: '"Source Code Pro", "Menlo", "Monaco", "Consolas", monospace', label: 'Source Code Pro' },
    { value: '"Ubuntu Mono", "Courier New", Courier, monospace', label: 'Ubuntu Mono' },
    { value: '"Roboto Mono", "Courier New", Courier, monospace', label: 'Roboto Mono' },
    { value: '"Space Mono", "Courier New", Courier, monospace', label: 'Space Mono' },
    { value: '"Courier Prime", "Courier New", Courier, monospace', label: 'Courier Prime' },
    { value: 'monospace', label: 'System Monospace' },
];
