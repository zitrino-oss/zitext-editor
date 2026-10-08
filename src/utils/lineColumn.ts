/** "12", "12:5" or "12,5" → line and column (column 1 when omitted). */
export function parseLineAndColumn(text: string): { line: number; column: number } | null {
    const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(text);
    if (!match) return null;
    return { line: Number(match[1]), column: match[2] ? Math.max(1, Number(match[2])) : 1 };
}
