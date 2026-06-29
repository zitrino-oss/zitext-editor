/**
 * Available Monaco Editor themes
 */
export interface ThemeDefinition {
    id: string;
    label: string;
    type: 'light' | 'dark';
}

export const AVAILABLE_THEMES: ThemeDefinition[] = [
    {
        id: 'vs',
        label: 'Light (Visual Studio)',
        type: 'light',
    },
    {
        id: 'vs-dark',
        label: 'Dark (Visual Studio)',
        type: 'dark',
    },
    {
        id: 'hc-black',
        label: 'High Contrast Dark',
        type: 'dark',
    },
    {
        id: 'hc-light',
        label: 'High Contrast Light',
        type: 'light',
    },
];

/**
 * Get theme by ID
 */
export function getThemeById(id: string): ThemeDefinition | undefined {
    return AVAILABLE_THEMES.find(theme => theme.id === id);
}

/**
 * Get default theme for app theme
 */
export function getDefaultEditorTheme(appTheme: 'light' | 'dark'): string {
    return appTheme === 'dark' ? 'vs-dark' : 'vs';
}

/**
 * Check if theme is light or dark
 */
export function isLightTheme(themeId: string): boolean {
    const theme = getThemeById(themeId);
    return theme?.type === 'light';
}
