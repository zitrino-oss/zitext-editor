// Language detection based on the file name; the data lives in languages.ts.
import { extensionForLanguage, languageForPath, languageLabel } from './languages';

export { extensionForLanguage };

export function detectLanguage(filePath: string | null): string {
    return languageForPath(filePath);
}

export function getLanguageDisplayName(language: string): string {
    return languageLabel(language);
}
