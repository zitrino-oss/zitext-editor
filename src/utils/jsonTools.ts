/**
 * Lossless JSON tools. Formatting and sorting operate on the syntax tree and
 * original token text, so large numeric literals and special keys are never
 * coerced through JavaScript objects or Number.
 */
import {
    applyEdits,
    createScanner,
    format,
    parseTree,
    printParseErrorCode,
    type Node,
    type ParseError,
} from 'jsonc-parser';

export interface JsonValidationResult {
    valid: boolean;
    error?: string;
    line?: number;
    column?: number;
}

const MAX_JSON_INPUT_CHARS = 20_000_000;
const MAX_JSON_DEPTH = 500;
// jsonc-parser declares these as ambient const enums, which cannot be read at
// runtime when TypeScript's isolatedModules mode is enabled.
const UNKNOWN_TOKEN = 16;
const EOF_TOKEN = 17;
const STRICT_PARSE_OPTIONS = {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
};

function ensureSize(text: string): void {
    if (text.length > MAX_JSON_INPUT_CHARS) {
        throw new Error(`Input too large to process (${text.length} characters).`);
    }
}

function parseStrict(text: string): Node {
    ensureSize(text);
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, STRICT_PARSE_OPTIONS);
    if (!root || errors.length > 0) {
        const first = errors[0];
        const reason = first ? printParseErrorCode(first.error) : 'ValueExpected';
        throw new Error(`${reason} at position ${first?.offset ?? 0}`);
    }
    return root;
}

export function formatJson(text: string, indent: number = 2): string {
    try {
        parseStrict(text);
        return applyEdits(text, format(text, undefined, {
            insertSpaces: true,
            tabSize: Math.max(1, indent),
            insertFinalNewline: false,
            keepLines: false,
        }));
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export function minifyJson(text: string): string {
    try {
        parseStrict(text);
        const scanner = createScanner(text, true);
        let result = '';
        for (let token = scanner.scan(); token !== EOF_TOKEN; token = scanner.scan()) {
            if (scanner.getTokenError() !== 0 || token === UNKNOWN_TOKEN) {
                throw new Error(`Invalid token at position ${scanner.getTokenOffset()}`);
            }
            result += text.slice(
                scanner.getTokenOffset(),
                scanner.getTokenOffset() + scanner.getTokenLength(),
            );
        }
        return result;
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export function validateJson(text: string): JsonValidationResult {
    try {
        parseStrict(text);
        return { valid: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const match = message.match(/position (\d+)/);
        if (!match) return { valid: false, error: message };
        const position = Number(match[1]);
        const lines = text.slice(0, position).split('\n');
        return {
            valid: false,
            error: message,
            line: lines.length,
            column: lines[lines.length - 1].length + 1,
        };
    }
}

function serializeSorted(
    node: Node,
    source: string,
    indent: number,
    depth: number,
): string {
    if (depth > MAX_JSON_DEPTH) {
        throw new Error('JSON nesting is too deep to sort safely.');
    }

    if (node.type === 'object') {
        const properties = [...(node.children ?? [])].sort((left, right) => {
            const leftKey = String(left.children?.[0]?.value ?? '');
            const rightKey = String(right.children?.[0]?.value ?? '');
            return leftKey.localeCompare(rightKey);
        });
        if (properties.length === 0) return '{}';
        const padding = ' '.repeat(indent * (depth + 1));
        const closingPadding = ' '.repeat(indent * depth);
        const entries = properties.map(property => {
            const key = property.children?.[0];
            const value = property.children?.[1];
            if (!key || !value) throw new Error('Malformed object property.');
            const rawKey = source.slice(key.offset, key.offset + key.length);
            return `${padding}${rawKey}: ${serializeSorted(value, source, indent, depth + 1)}`;
        });
        return `{\n${entries.join(',\n')}\n${closingPadding}}`;
    }

    if (node.type === 'array') {
        const values = node.children ?? [];
        if (values.length === 0) return '[]';
        const padding = ' '.repeat(indent * (depth + 1));
        const closingPadding = ' '.repeat(indent * depth);
        return `[\n${values
            .map(value => `${padding}${serializeSorted(value, source, indent, depth + 1)}`)
            .join(',\n')}\n${closingPadding}]`;
    }

    return source.slice(node.offset, node.offset + node.length);
}

export function sortJsonKeys(text: string, indent: number = 2): string {
    try {
        const root = parseStrict(text);
        return serializeSorted(root, text, Math.max(1, indent), 0);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export function escapeJsonString(str: string): string {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

export function isValidJson(text: string): boolean {
    return validateJson(text).valid;
}
