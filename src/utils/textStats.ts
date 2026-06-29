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
