/**
 * Text and Data Tools as the command palette and the menus list them. The
 * work is done in utils/textToolRunner (loaded when a tool is first used).
 */
export type TextToolId =
    // Lines
    | 'sortAsc' | 'sortDesc' | 'sortNumeric' | 'dedupe' | 'removeEmpty' | 'collapseEmpty'
    | 'trimLeading' | 'trimTrailing' | 'trimBoth' | 'reverse' | 'join' | 'split' | 'countUnique'
    // Case
    | 'upper' | 'lower' | 'title'
    // Encode / decode
    | 'urlEncode' | 'urlDecode' | 'base64Encode' | 'base64Decode' | 'htmlEscape' | 'htmlUnescape'
    | 'jsonEscape' | 'jsonUnescape' | 'jwtDecode'
    // Generate and checksums
    | 'uuid' | 'sha256' | 'md5' | 'unixToDate' | 'dateToUnix'
    // Convert
    | 'csvToJson' | 'jsonToCsv' | 'csvToTsv' | 'tsvToCsv' | 'tsvToJson' | 'jsonToTsv' | 'xmlMinify';

export interface TextToolInfo {
    id: TextToolId;
    group: 'Lines' | 'Case' | 'Encode' | 'Generate' | 'Convert';
    label: string;
    description: string;
}

/** Category shown in the palette for every tool; also the palette filter the
 *  "Text and Data Tools…" menu item opens with. */
export const TEXT_TOOLS_CATEGORY = 'Text & Data';

export const TEXT_TOOLS: TextToolInfo[] = [
    { id: 'sortAsc', group: 'Lines', label: 'Sort Lines Ascending', description: 'A to Z (selected lines, or the whole document)' },
    { id: 'sortDesc', group: 'Lines', label: 'Sort Lines Descending', description: 'Z to A' },
    { id: 'sortNumeric', group: 'Lines', label: 'Sort Lines Numerically', description: 'By the first number in each line' },
    { id: 'dedupe', group: 'Lines', label: 'Remove Duplicate Lines', description: 'Keep the first of each' },
    { id: 'removeEmpty', group: 'Lines', label: 'Remove Empty Lines', description: 'Including lines with only spaces' },
    { id: 'collapseEmpty', group: 'Lines', label: 'Remove Duplicate Empty Lines', description: 'Runs of blank lines become one' },
    { id: 'trimLeading', group: 'Lines', label: 'Trim Leading Spaces', description: 'Each line' },
    { id: 'trimTrailing', group: 'Lines', label: 'Trim Trailing Spaces', description: 'Each line' },
    { id: 'trimBoth', group: 'Lines', label: 'Trim Both Ends', description: 'Each line' },
    { id: 'reverse', group: 'Lines', label: 'Reverse Lines', description: 'Last line first' },
    { id: 'join', group: 'Lines', label: 'Join Lines', description: 'Into one line, separated by spaces' },
    { id: 'split', group: 'Lines', label: 'Split Lines…', description: 'At a delimiter you choose' },
    { id: 'countUnique', group: 'Lines', label: 'Count Unique Lines', description: 'Opens a report in a new tab' },
    { id: 'upper', group: 'Case', label: 'Convert to Uppercase', description: 'Selection, or the whole document' },
    { id: 'lower', group: 'Case', label: 'Convert to Lowercase', description: 'Selection, or the whole document' },
    { id: 'title', group: 'Case', label: 'Convert to Title Case', description: 'Selection, or the whole document' },
    { id: 'urlEncode', group: 'Encode', label: 'URL Encode', description: 'Percent-encode the selection' },
    { id: 'urlDecode', group: 'Encode', label: 'URL Decode', description: 'Decode percent-encoding' },
    { id: 'base64Encode', group: 'Encode', label: 'Base64 Encode', description: 'UTF-8 text to Base64' },
    { id: 'base64Decode', group: 'Encode', label: 'Base64 Decode', description: 'Base64 to UTF-8 text' },
    { id: 'htmlEscape', group: 'Encode', label: 'HTML Escape', description: '& < > " \' to entities' },
    { id: 'htmlUnescape', group: 'Encode', label: 'HTML Unescape', description: 'Entities to characters' },
    { id: 'jsonEscape', group: 'Encode', label: 'JSON Escape', description: 'Text to the inside of a JSON string' },
    { id: 'jsonUnescape', group: 'Encode', label: 'JSON Unescape', description: 'A JSON string back to text' },
    { id: 'jwtDecode', group: 'Encode', label: 'Decode JWT', description: 'Header and claims in a new tab, locally; the signature is not checked' },
    { id: 'uuid', group: 'Generate', label: 'Insert UUID', description: 'A random UUID at each cursor' },
    { id: 'sha256', group: 'Generate', label: 'SHA-256 Checksum', description: 'Of the selection or document, copied to the clipboard' },
    { id: 'md5', group: 'Generate', label: 'MD5 Checksum', description: 'Of the selection or document, copied to the clipboard' },
    { id: 'unixToDate', group: 'Generate', label: 'Unix Timestamp to Date', description: 'Replace the selected timestamp with an ISO date (UTC)' },
    { id: 'dateToUnix', group: 'Generate', label: 'Date to Unix Timestamp', description: 'Replace the selected date with Unix seconds (a date without a time zone is read as UTC)' },
    { id: 'csvToJson', group: 'Convert', label: 'Convert CSV to JSON', description: 'First row is the header; opens in a new tab' },
    { id: 'jsonToCsv', group: 'Convert', label: 'Convert JSON to CSV', description: 'An array of objects or of arrays; opens in a new tab' },
    { id: 'csvToTsv', group: 'Convert', label: 'Convert CSV to TSV', description: 'Opens in a new tab' },
    { id: 'tsvToCsv', group: 'Convert', label: 'Convert TSV to CSV', description: 'Opens in a new tab' },
    { id: 'tsvToJson', group: 'Convert', label: 'Convert TSV to JSON', description: 'First row is the header; opens in a new tab' },
    { id: 'jsonToTsv', group: 'Convert', label: 'Convert JSON to TSV', description: 'Opens in a new tab' },
    { id: 'xmlMinify', group: 'Convert', label: 'Minify XML', description: 'Remove line breaks and indentation between tags; text and spaces in content are kept' },
];
