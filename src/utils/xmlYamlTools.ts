/**
 * XML and YAML Formatting Tools
 */

import { parseDocument } from 'yaml';

// Guards against pathological input freezing the UI thread during formatting.
const MAX_FORMAT_INPUT_CHARS = 20_000_000; // ~20M characters

/**
 * Format XML with proper indentation
 */
export function formatXml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('XML input is too large to format.');
    }
    try {
        // Remove existing whitespace between tags
        let xml = text.replace(/>\s*</g, '><');

        // Add newlines and indentation
        let formatted = '';
        let indentLevel = 0;
        const indentStr = ' '.repeat(indent);

        // Split by tags
        const parts = xml.split(/(<[^>]+>)/g).filter(part => part.trim());

        for (const part of parts) {
            if (!part.trim()) continue;

            // Check if it's a tag
            if (part.startsWith('<')) {
                // Closing tag
                if (part.startsWith('</')) {
                    indentLevel = Math.max(0, indentLevel - 1);
                    formatted += indentStr.repeat(indentLevel) + part + '\n';
                }
                // Self-closing tag or declaration
                else if (part.endsWith('/>') || part.startsWith('<?') || part.startsWith('<!')) {
                    formatted += indentStr.repeat(indentLevel) + part + '\n';
                }
                // Opening tag
                else {
                    formatted += indentStr.repeat(indentLevel) + part + '\n';
                    indentLevel++;
                }
            }
            // Text content
            else {
                const trimmed = part.trim();
                if (trimmed) {
                    formatted += indentStr.repeat(indentLevel) + trimmed + '\n';
                }
            }
        }

        return formatted.trim();
    } catch (error) {
        throw new Error(`Failed to format XML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Format YAML with proper indentation.
 *
 * Uses the `yaml` package's document model, which round-trips comments and
 * normalizes indentation/spacing without altering the document's structure or
 * values. This replaces the previous hand-rolled line reformatter, which could
 * silently corrupt valid YAML (e.g. treating `#` inside a quoted value as a
 * comment, or splitting on a `:` inside a quoted string).
 */
export function formatYaml(text: string, indent: number = 2): string {
    if (text.length > MAX_FORMAT_INPUT_CHARS) {
        throw new Error('YAML input is too large to format.');
    }
    try {
        const doc = parseDocument(text);
        // Surface genuine syntax errors rather than emitting partial output.
        if (doc.errors.length > 0) {
            throw new Error(doc.errors[0].message);
        }
        return doc.toString({ indent }).trimEnd();
    } catch (error) {
        throw new Error(`Failed to format YAML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Validate XML (basic check)
 */
export function validateXml(text: string): { valid: boolean; error?: string } {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');

        // Check for parsing errors
        const parserError = doc.querySelector('parsererror');
        if (parserError) {
            return {
                valid: false,
                error: parserError.textContent || 'XML parsing error',
            };
        }

        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Check if text is valid XML
 */
export function isValidXml(text: string): boolean {
    return validateXml(text).valid;
}
