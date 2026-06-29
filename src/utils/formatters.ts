/**
 * Format JSON with pretty printing
 */
export function formatJson(content: string, sortKeys: boolean = false): string {
    try {
        const parsed = JSON.parse(content);

        if (sortKeys) {
            const sorted = sortJsonKeys(parsed);
            return JSON.stringify(sorted, null, 2);
        }

        return JSON.stringify(parsed, null, 2);
    } catch (error) {
        throw new Error(`Invalid JSON: ${(error as Error).message}`);
    }
}

/**
 * Minify JSON (remove whitespace)
 */
export function minifyJson(content: string): string {
    try {
        const parsed = JSON.parse(content);
        return JSON.stringify(parsed);
    } catch (error) {
        throw new Error(`Invalid JSON: ${(error as Error).message}`);
    }
}

/**
 * Recursively sort JSON object keys
 */


function sortJsonKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(sortJsonKeys);
    }

    const sorted: any = {};
    Object.keys(obj).sort().forEach(key => {
        sorted[key] = sortJsonKeys(obj[key]);
    });
    return sorted;
}

/**
 * Validate JSON and return diagnostics
 */
export function validateJson(content: string): { valid: boolean; error?: string; line?: number; column?: number } {
    try {
        JSON.parse(content);
        return { valid: true };
    } catch (error: any) {
        const message = error.message || 'Unknown error';

        // Try to extract line/column from error message
        const match = message.match(/position (\d+)/);
        if (match) {
            const position = parseInt(match[1]);
            const lines = content.substring(0, position).split('\n');
            const line = lines.length;
            const column = lines[lines.length - 1].length + 1;
            return { valid: false, error: message, line, column };
        }

        return { valid: false, error: message };
    }
}

/**
 * Format XML with basic indentation
 */
export function formatXml(content: string): string {
    try {
        let formatted = '';
        let indent = 0;
        const tab = '  ';

        // Remove existing whitespace between tags
        content = content.replace(/>\s*</g, '><');

        // Split by tags
        const parts = content.split(/(<[^>]+>)/g).filter(part => part.trim());

        for (const part of parts) {
            if (part.startsWith('</')) {
                // Closing tag
                indent--;
                formatted += tab.repeat(Math.max(0, indent)) + part + '\n';
            } else if (part.startsWith('<') && !part.endsWith('/>') && !part.startsWith('<?') && !part.startsWith('<!')) {
                // Opening tag
                formatted += tab.repeat(indent) + part + '\n';
                indent++;
            } else if (part.startsWith('<') && part.endsWith('/>')) {
                // Self-closing tag
                formatted += tab.repeat(indent) + part + '\n';
            } else if (part.startsWith('<?') || part.startsWith('<!')) {
                // Declaration or comment
                formatted += part + '\n';
            } else {
                // Text content
                const trimmed = part.trim();
                if (trimmed) {
                    formatted += tab.repeat(indent) + trimmed + '\n';
                }
            }
        }

        return formatted.trim();
    } catch (error) {
        throw new Error(`Failed to format XML: ${(error as Error).message}`);
    }
}

/**
 * Format YAML with basic indentation (best-effort)
 */
export function formatYaml(content: string): string {
    try {
        const lines = content.split('\n');
        let formatted = '';
        let indent = 0;
        const tab = '  ';

        for (let line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) {
                formatted += line + '\n';
                continue;
            }

            // Detect indentation changes
            if (trimmed.endsWith(':')) {
                // Key without value - increase indent for next line
                formatted += tab.repeat(indent) + trimmed + '\n';
                indent++;
            } else if (trimmed.startsWith('- ')) {
                // List item
                formatted += tab.repeat(indent) + trimmed + '\n';
            } else if (trimmed.includes(': ')) {
                // Key-value pair
                formatted += tab.repeat(indent) + trimmed + '\n';
            } else {
                // Continuation or value
                formatted += tab.repeat(indent) + trimmed + '\n';
            }

            // Detect dedent (heuristic: line doesn't start with - or contain :)
            if (!trimmed.startsWith('- ') && !trimmed.includes(':') && indent > 0) {
                indent = Math.max(0, indent - 1);
            }
        }

        return formatted;
    } catch (error) {
        throw new Error(`Failed to format YAML: ${(error as Error).message}`);
    }
}

/**
 * Auto-detect format and apply appropriate formatter
 */
export function autoFormat(content: string, language: string, sortKeys: boolean = false): string {
    switch (language) {
        case 'json':
            return formatJson(content, sortKeys);
        case 'xml':
            return formatXml(content);
        case 'yaml':
        case 'yml':
            return formatYaml(content);
        default:
            throw new Error(`Formatting not supported for language: ${language}`);
    }
}
