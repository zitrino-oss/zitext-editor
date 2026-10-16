/**
 * Text Statistics Utilities
 * 
 * Utilities for calculating text statistics like character count,
 * word count, and formatting file sizes.
 */

export interface TextStats {
    chars: number;
    words: number;
    lines: number;
    selectedChars?: number;
}

/**
 * Calculate text statistics from content
 */
export function calculateTextStats(
    content: string,
    selectionLength?: number
): TextStats {
    const lines = content.split('\n').length;
    const chars = content.length;

    // Count words (split by whitespace, filter empty strings)
    const words = content
        .split(/\s+/)
        .filter(word => word.length > 0).length;

    return {
        chars,
        words,
        lines,
        selectedChars: selectionLength && selectionLength > 0 ? selectionLength : undefined,
    };
}

/**
 * Size of the text once saved in the tab's encoding, in bytes. JavaScript
 * string length counts UTF-16 code units, which is neither: "é" is one unit
 * but two UTF-8 bytes, and an emoji is two units but four bytes.
 */
export function encodedByteLength(text: string, encoding = 'UTF-8'): number {
    // Windows-1252 stores one byte per character.
    if (encoding.toLowerCase() === 'windows-1252') return text.length;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit < 0x80) bytes += 1;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
            bytes += 4; // a surrogate pair is one 4-byte character
            i++;
        } else bytes += 3; // includes a lone surrogate, saved as U+FFFD
    }
    return encoding.toLowerCase() === 'utf-8 with bom' ? bytes + 3 : bytes;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format number with thousand separators
 */
export function formatNumber(num: number): string {
    return num.toLocaleString();
}
