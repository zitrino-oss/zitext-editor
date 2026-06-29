/**
 * JSON Tools - Format, Minify, Validate, Sort Keys
 */

export interface JsonValidationResult {
    valid: boolean;
    error?: string;
    line?: number;
    column?: number;
}

// Guard against pathological input freezing the UI thread, and against deeply
// nested structures overflowing the stack during the recursive key sort.
const MAX_JSON_INPUT_CHARS = 20_000_000; // ~20M characters
const MAX_JSON_DEPTH = 500;

function ensureSize(text: string): void {
    if (text.length > MAX_JSON_INPUT_CHARS) {
        throw new Error(`Input too large to process (${text.length} characters).`);
    }
}

/**
 * Format JSON with indentation
 */
export function formatJson(text: string, indent: number = 2): string {
    try {
        ensureSize(text);
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, indent);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Minify JSON (remove whitespace)
 */
export function minifyJson(text: string): string {
    try {
        ensureSize(text);
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Validate JSON and return detailed error info
 */
export function validateJson(text: string): JsonValidationResult {
    try {
        JSON.parse(text);
        return { valid: true };
    } catch (error) {
        if (error instanceof SyntaxError) {
            // Try to extract line/column from error message
            const match = error.message.match(/position (\d+)/);
            if (match) {
                const position = parseInt(match[1]);
                const lines = text.substring(0, position).split('\n');
                const line = lines.length;
                const column = lines[lines.length - 1].length + 1;

                return {
                    valid: false,
                    error: error.message,
                    line,
                    column,
                };
            }

            return {
                valid: false,
                error: error.message,
            };
        }

        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Sort JSON keys alphabetically (recursive)
 */
export function sortJsonKeys(text: string, indent: number = 2): string {
    try {
        ensureSize(text);
        const parsed = JSON.parse(text);
        const sorted = sortObjectKeys(parsed);
        return JSON.stringify(sorted, null, indent);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Recursively sort object keys
 */


function sortObjectKeys(obj: any, depth: number = 0): any {
    if (depth > MAX_JSON_DEPTH) {
        throw new Error('JSON nesting is too deep to sort safely.');
    }

    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sortObjectKeys(item, depth + 1));
    }

    const sorted: any = {};
    const keys = Object.keys(obj).sort();

    for (const key of keys) {
        sorted[key] = sortObjectKeys(obj[key], depth + 1);
    }

    return sorted;
}

/**
 * Escape JSON string for safe display
 */
export function escapeJsonString(str: string): string {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

/**
 * Check if text is valid JSON
 */
export function isValidJson(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}
