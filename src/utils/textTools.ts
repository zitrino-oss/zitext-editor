/**
 * Text and Data Tools: line, case, encoding, checksum, date and format
 * conversions (utils/textToolRunner applies them to the editor). All local;
 * nothing here touches the network. Lines are passed without terminators.
 */

// ─── Lines ─────────────────────────────────────────────────────────────────

export type LineOp =
    | 'sortAsc' | 'sortDesc' | 'sortNumeric'
    | 'dedupe' | 'removeEmpty' | 'collapseEmpty'
    | 'trimLeading' | 'trimTrailing' | 'trimBoth'
    | 'reverse' | 'join';

const isBlank = (line: string) => line.trim() === '';

let collator: Intl.Collator | null = null;
/** Case- and accent-insensitive order first ("apple" next to "Apple"), then a
 *  plain comparison, so the result doesn't depend on the input order. */
function compareText(a: string, b: string): number {
    collator ??= new Intl.Collator(undefined, { sensitivity: 'base', numeric: false });
    return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const NUMBER = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
function firstNumber(line: string): number | null {
    const match = NUMBER.exec(line);
    if (!match) return null;
    let text = match[0];
    // "id-10" is id 10, not minus ten: a sign right after a word character
    // is a hyphen.
    if ((text[0] === '-' || text[0] === '+') && match.index > 0 && WORD_CHAR.test(line[match.index - 1])) text = text.slice(1);
    const value = Number(text);
    return Number.isNaN(value) ? null : value;
}

export function transformLines(lines: string[], op: LineOp): string[] {
    switch (op) {
        case 'sortAsc': return [...lines].sort(compareText);
        case 'sortDesc': return [...lines].sort((a, b) => compareText(b, a));
        case 'sortNumeric': {
            // Lines without a number keep their order, after the numbered ones.
            const keyed = lines.map(line => ({ line, value: firstNumber(line) }));
            keyed.sort((a, b) => {
                if (a.value === null || b.value === null) return a.value === null ? (b.value === null ? 0 : 1) : -1;
                return a.value - b.value;
            });
            return keyed.map(entry => entry.line);
        }
        case 'dedupe': {
            const seen = new Set<string>();
            return lines.filter(line => (seen.has(line) ? false : (seen.add(line), true)));
        }
        case 'removeEmpty': return lines.filter(line => !isBlank(line));
        case 'collapseEmpty': {
            const out: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (!isBlank(lines[i])) { out.push(lines[i]); continue; }
                let end = i;
                while (end + 1 < lines.length && isBlank(lines[end + 1])) end++;
                out.push(end > i ? '' : lines[i]);
                i = end;
            }
            return out;
        }
        case 'trimLeading': return lines.map(line => line.trimStart());
        case 'trimTrailing': return lines.map(line => line.trimEnd());
        case 'trimBoth': return lines.map(line => line.trim());
        case 'reverse': return [...lines].reverse();
        case 'join': return [lines.map(line => line.trim()).filter(line => line !== '').join(' ')];
    }
}

export function splitLines(lines: string[], delimiter: string, trimPieces = false): string[] {
    if (!delimiter) throw new Error('Enter a delimiter to split on.');
    return lines.flatMap(line => line.split(delimiter).map(piece => (trimPieces ? piece.trim() : piece)));
}

// ─── Case ──────────────────────────────────────────────────────────────────

export type CaseOp = 'upper' | 'lower' | 'title';

const WORD_BREAKS = new Set(['-', '_', '/', '(', '[', '{', '"', '\'']);
const LETTER = /\p{L}/u;

export function changeCase(text: string, op: CaseOp): string {
    if (op === 'upper') return text.toUpperCase();
    if (op === 'lower') return text.toLowerCase();
    let out = '';
    let atWordStart = true;
    let previous = '';
    for (const ch of text) {
        // An apostrophe inside a word ("don't") doesn't start a new one.
        const breaks = /\s/.test(ch) || (WORD_BREAKS.has(ch) && !(ch === '\'' && LETTER.test(previous)));
        if (breaks) {
            out += ch;
            atWordStart = true;
        } else {
            out += atWordStart ? ch.toUpperCase() : ch.toLowerCase();
            atWordStart = false;
        }
        previous = ch;
    }
    return out;
}

// ─── Counting ──────────────────────────────────────────────────────────────

export function countUniqueLines(lines: string[]): { line: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    // Map keeps first-appearance order and sort is stable, so ties stay in it.
    return [...counts].map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count);
}

export function formatLineCounts(counts: { line: string; count: number }[], totalLines: number): string {
    const header = `${totalLines} ${totalLines === 1 ? 'line' : 'lines'}, ${counts.length} unique`;
    return [header, '', ...counts.map(({ line, count }) => `${count}\t${line}`)].join('\n');
}

// ─── Encoding ──────────────────────────────────────────────────────────────

export type CodecOp =
    | 'urlEncode' | 'urlDecode' | 'base64Encode' | 'base64Decode'
    | 'htmlEscape' | 'htmlUnescape' | 'jsonEscape' | 'jsonUnescape';

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
    let clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('This isn\'t valid Base64.');
    clean = clean.replace(/=+$/, '');
    if (clean.length % 4 === 1) throw new Error('This isn\'t valid Base64.');
    clean += '='.repeat((4 - (clean.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(clean);
    } catch {
        throw new Error('This isn\'t valid Base64.');
    }
    return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function decodeUtf8(bytes: Uint8Array): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('The decoded data isn\'t text (not valid UTF-8).');
    }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const HTML_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', copy: '©', reg: '®', trade: '™',
    hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€',
    pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±', times: '×', divide: '÷',
    middot: '·', bull: '•', laquo: '«', raquo: '»',
};

function unescapeHtml(text: string): string {
    return text.replace(/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g, (whole, body: string) => {
        if (body[0] !== '#') return HTML_ENTITIES[body] ?? whole;
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        // Out of range and lone surrogates stay as written.
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
        return String.fromCodePoint(code);
    });
}

export function applyCodec(text: string, op: CodecOp): string {
    switch (op) {
        case 'urlEncode':
            try {
                return encodeURIComponent(text);
            } catch {
                throw new Error('This text has a broken character and can\'t be URL-encoded.');
            }
        case 'urlDecode':
            try {
                return decodeURIComponent(text.replace(/\+/g, ' '));
            } catch {
                throw new Error('This isn\'t valid URL-encoded text.');
            }
        case 'base64Encode': return bytesToBase64(new TextEncoder().encode(text));
        case 'base64Decode': return decodeUtf8(base64ToBytes(text));
        case 'htmlEscape': return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
        case 'htmlUnescape': return unescapeHtml(text);
        case 'jsonEscape': return JSON.stringify(text).slice(1, -1);
        case 'jsonUnescape': {
            const inner = text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
            try {
                return JSON.parse(`"${inner}"`) as string;
            } catch {
                throw new Error('This isn\'t a valid JSON string.');
            }
        }
    }
}

// ─── Checksums ─────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** MD5 (RFC 1321) of the UTF-8 bytes. The webview's crypto has no MD5. */
export function md5Hex(text: string): string {
    const input = new TextEncoder().encode(text);
    const length = input.length;
    const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
    padded.set(input);
    padded[length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (length * 8) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);

    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const words = new Uint32Array(16);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
            let f: number;
            let g: number;
            if (i < 16) { f = (b & c) | (~b & d); g = i; }
            else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
            else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * i) % 16; }
            const sum = (a + f + constants[i] + words[g]) >>> 0;
            const shift = shifts[(i >> 4) * 4 + (i % 4)];
            a = d;
            d = c;
            c = b;
            b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    const digest = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((word, i) => digest.setUint32(i * 4, word, true));
    return toHex(new Uint8Array(digest.buffer));
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return toHex(new Uint8Array(digest));
}

// ─── Dates ─────────────────────────────────────────────────────────────────

const MAX_TIME_MS = 8.64e15; // the range JavaScript dates can show

function isoFromMillis(ms: number): string {
    return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export function unixToIso(text: string): string {
    const value = text.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    const invalid = new Error('This isn\'t a Unix timestamp.');
    if (!match) throw invalid;
    const digits = match[2].replace(/^0+(?=\d)/, '').length;
    let ms: number;
    if (digits <= 11) ms = Math.round(Number(value) * 1000);
    else if (!match[3] && digits <= 13) ms = Number(value);
    else if (!match[3] && digits === 16) ms = Math.trunc(Number(value) / 1000);
    else throw invalid;
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) throw invalid;
    return isoFromMillis(ms);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function daysIn(year: number, month: number): number {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Milliseconds since the epoch, or null when a field is out of range. */
function utcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number, fraction: string, offsetMinutes: number): number | null {
    if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59) return null;
    const ms = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
    // Date.UTC reads years 0–99 as 1900–1999; the year is set separately.
    const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, ms));
    date.setUTCFullYear(year);
    const time = date.getTime() - offsetMinutes * 60_000;
    return Number.isFinite(time) ? time : null;
}

function offsetOf(zone: string | undefined): number {
    if (!zone || /^(Z|GMT|UTC|UT)$/i.test(zone)) return 0;
    const match = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!match) return NaN;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * A date or time as Unix seconds. Reads ISO 8601, RFC 2822 and
 * "YYYY/MM/DD HH:MM[:SS]". A time without a zone is taken as UTC (a log's
 * local zone can't be known), so the result doesn't depend on this computer.
 */
export function dateToUnix(text: string): string {
    const value = text.trim();
    let ms: number | null = null;
    let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
    if (match) {
        const offset = offsetOf(match[8]);
        if (!Number.isNaN(offset)) {
            ms = utcMillis(+match[1], +match[2], +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0), match[7] ?? '', offset);
        }
    } else if ((match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value))) {
        ms = utcMillis(+match[1], +match[2], +match[3], +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0), '', 0);
    } else if ((match = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|UT|Z|[+-]\d{4})?$/i.exec(value))) {
        const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
        const offset = offsetOf(match[7]);
        if (month > 0 && !Number.isNaN(offset)) {
            ms = utcMillis(+match[3], month, +match[1], +match[4], +match[5], +(match[6] ?? 0), '', offset);
        }
    }
    if (ms === null) throw new Error('This isn\'t a date ZITEXT can read. Try 2026-10-07T14:30:00Z.');
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, '');
}

// ─── JWT ───────────────────────────────────────────────────────────────────

/** Decodes a JSON Web Token on this computer. The signature is not checked. */
export function decodeJwt(token: string): string {
    const invalid = new Error('This isn\'t a JSON Web Token.');
    const parts = token.trim().replace(/^Bearer\s+/i, '').split('.');
    if (parts.length < 2 || parts.length > 3) throw invalid;
    const part = (text: string): Record<string, unknown> => {
        try {
            const value: unknown = JSON.parse(decodeUtf8(base64ToBytes(text)));
            if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid;
            return value as Record<string, unknown>;
        } catch {
            throw invalid;
        }
    };
    const header = part(parts[0]);
    const payload = part(parts[1]);
    const result: Record<string, unknown> = { header, payload, signature: parts[2] ? 'present, not verified' : 'none' };
    const times: Record<string, string> = {};
    for (const claim of ['exp', 'iat', 'nbf']) {
        const seconds = payload[claim];
        if (typeof seconds === 'number' && Number.isFinite(seconds) && Math.abs(seconds * 1000) <= MAX_TIME_MS) {
            times[claim] = isoFromMillis(Math.round(seconds * 1000));
        }
    }
    if (Object.keys(times).length > 0) result.times = times;
    return JSON.stringify(result, null, 2);
}

// ─── CSV / TSV / JSON ──────────────────────────────────────────────────────

/**
 * RFC 4180 parsing (quoted fields, "" escapes, line breaks inside quotes).
 * A field that only starts with a quote ("Quoted" title) is read as written.
 * TSV is often written without quoting at all, so a TSV with an unmatched
 * quote is read with quotes as ordinary characters instead of failing.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
    try {
        return parseQuoted(text, delimiter);
    } catch (error) {
        if (delimiter !== '\t') throw error;
        const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
        const lines = text.slice(start).split(/\r\n|\r|\n/);
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        return lines.map(line => line.split(delimiter));
    }
}

function parseQuoted(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let quoteRow = 0;
    let fieldStarted = false;
    let fieldStart = 0;
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const endRow = () => {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        fieldStarted = false;
    };
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else {
                    inQuotes = false;
                    const next = text[i + 1];
                    if (next !== undefined && next !== delimiter && next !== '\r' && next !== '\n') {
                        // Text after the closing quote: the quote wasn't
                        // quoting; take the field exactly as written.
                        let end = i + 1;
                        while (end < text.length && text[end] !== delimiter && text[end] !== '\r' && text[end] !== '\n') end++;
                        field = text.slice(fieldStart, end);
                        i = end - 1;
                    }
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"' && !fieldStarted && field === '') {
            inQuotes = true;
            fieldStarted = true;
            fieldStart = i;
            quoteRow = rows.length + 1;
        } else if (ch === delimiter) {
            row.push(field);
            field = '';
            fieldStarted = false;
        } else if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            endRow();
        } else {
            field += ch;
            fieldStarted = true;
        }
    }
    if (inQuotes) throw new Error(`A quoted field is not closed (row ${quoteRow}).`);
    // A trailing line break doesn't add an empty row.
    if (field !== '' || fieldStarted || row.length > 0) endRow();
    return rows;
}

export function formatDelimited(rows: string[][], delimiter: string, eol: string): string {
    const quote = (field: string) => (
        field.includes(delimiter) || /["\r\n]/.test(field) || /^\s|\s$/.test(field)
            ? `"${field.replace(/"/g, '""')}"`
            : field
    );
    return rows.map((row, index) =>
        // A last row of one empty field would be an empty last line, which
        // reads back as no row at all; written as "" it survives.
        (index === rows.length - 1 && row.length === 1 && row[0] === '' ? '""' : row.map(quote).join(delimiter)))
        .join(eol);
}

/** Column names from a header row: blanks named column_N, repeats made unique. */
function columnNames(header: string[], width: number): string[] {
    const names: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < width; i++) {
        const base = i < header.length && header[i] !== '' ? header[i] : `column_${i + 1}`;
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
        used.add(name);
        names.push(name);
    }
    return names;
}

/** Values stay text: no number guessing, so IDs and leading zeros are kept exactly. */
export function delimitedToJson(text: string, delimiter: string): string {
    const rows = parseDelimited(text, delimiter);
    if (rows.length === 0) return '[]';
    // A loop, not Math.max(...rows): spreading 100,000+ rows overflows the stack.
    let width = 0;
    for (const row of rows) if (row.length > width) width = row.length;
    const names = columnNames(rows[0], width);
    // A blank line is not a record. Records have no prototype, so a column
    // named __proto__ is kept like any other.
    const records = rows.slice(1).filter(row => !(row.length === 1 && row[0] === '')).map(row => {
        const record: Record<string, string> = Object.create(null) as Record<string, string>;
        const length = Math.max(rows[0].length, row.length);
        for (let i = 0; i < length; i++) record[names[i]] = row[i] ?? '';
        return record;
    });
    return JSON.stringify(records, null, 2);
}

function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (value instanceof RawNumber) return value.text;
    if (typeof value === 'object') return JSON.stringify(value, (_key, inner) => (inner instanceof RawNumber ? Number(inner.text) : inner));
    return String(value);
}

/** A JSON number as written, so 12345678901234567890 or 1.10 reach the CSV
 *  unchanged (JSON.parse would round or reformat them). */
class RawNumber {
    constructor(readonly text: string) {}
}

/** JSON.parse, except numbers stay as their source text (RawNumber). Run
 *  after JSON.parse has validated the text, so it only has to read. */
function parseKeepingNumbers(text: string): unknown {
    let i = 0;
    const space = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
    const value = (): unknown => {
        space();
        const ch = text[i];
        if (ch === '{') {
            i++;
            const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            space();
            if (text[i] === '}') { i++; return object; }
            for (;;) {
                space();
                const key = value() as string;
                space();
                i++; // ':'
                object[key] = value();
                space();
                if (text[i++] === '}') return object;
            }
        }
        if (ch === '[') {
            i++;
            const array: unknown[] = [];
            space();
            if (text[i] === ']') { i++; return array; }
            for (;;) {
                array.push(value());
                space();
                if (text[i++] === ']') return array;
            }
        }
        if (ch === '"') {
            const start = i;
            i++;
            while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
            i++;
            return JSON.parse(text.slice(start, i)) as string;
        }
        const start = i;
        while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
        const word = text.slice(start, i);
        if (word === 'true') return true;
        if (word === 'false') return false;
        if (word === 'null') return null;
        return new RawNumber(word);
    };
    return value();
}

export function jsonToDelimited(text: string, delimiter: string, eol: string): string {
    let data: unknown;
    try {
        JSON.parse(text);
    } catch (error) {
        throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    data = parseKeepingNumbers(text);
    const isRecord = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RawNumber);
    const unsupported = new Error('Convert to CSV needs a JSON array of objects or of arrays.');
    if (isRecord(data)) data = [data];
    if (!Array.isArray(data)) throw unsupported;
    if (data.length === 0) return '';
    if (data.every(Array.isArray)) {
        return formatDelimited((data as unknown[][]).map(row => row.map(cellText)), delimiter, eol);
    }
    if (!data.every(isRecord)) throw unsupported;
    const records = data as Record<string, unknown>[];
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const record of records) {
        for (const key of Object.keys(record)) {
            if (!seen.has(key)) { seen.add(key); columns.push(key); }
        }
    }
    return formatDelimited([columns, ...records.map(record => columns.map(column => cellText(record[column])))], delimiter, eol);
}

export function convertDelimited(text: string, from: string, to: string, eol: string): string {
    return formatDelimited(parseDelimited(text, from), to, eol);
}

// ─── XML ───────────────────────────────────────────────────────────────────

/**
 * Removes line breaks and indentation between markup and nothing else: comments,
 * CDATA, processing instructions, DOCTYPE and attribute values are copied as
 * written, and elements under xml:space="preserve" keep their whitespace.
 * One pass, no backtracking.
 */
export function minifyXml(text: string): string {
    const out: string[] = [];
    // xml:space in effect for each open element (true = preserve).
    const preserve: boolean[] = [];
    const fail = (reason: string) => new Error(`Unable to minify XML: ${reason}`);
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '<') {
            const next = text.indexOf('<', i);
            const end = next === -1 ? text.length : next;
            const run = text.slice(i, end);
            // Only layout is removed: whitespace with a line break (the
            // indentation of pretty-printed XML). A space on one line, as in
            // <b>a</b> <i>b</i> or <sep> </sep>, can be content and is kept.
            const layout = run.trim() === '' && /[\r\n]/.test(run);
            if (!layout || preserve[preserve.length - 1]) out.push(run);
            i = end;
            continue;
        }
        let end: number;
        if (text.startsWith('<!--', i)) {
            end = text.indexOf('-->', i + 4);
            if (end === -1) throw fail('a comment is not closed.');
            end += 3;
        } else if (text.startsWith('<![CDATA[', i)) {
            end = text.indexOf(']]>', i + 9);
            if (end === -1) throw fail('a CDATA section is not closed.');
            end += 3;
        } else if (text.startsWith('<?', i)) {
            end = text.indexOf('?>', i + 2);
            if (end === -1) throw fail('a processing instruction is not closed.');
            end += 2;
        } else if (text.startsWith('<!', i)) {
            // DOCTYPE, possibly with an internal subset in [ ].
            let depth = 0;
            let quote = '';
            end = -1;
            for (let j = i + 2; j < text.length; j++) {
                const ch = text[j];
                if (quote) { if (ch === quote) quote = ''; }
                else if (ch === '"' || ch === '\'') quote = ch;
                else if (ch === '[') depth++;
                else if (ch === ']') depth--;
                else if (ch === '>' && depth <= 0) { end = j + 1; break; }
            }
            if (end === -1) throw fail('a declaration is not closed.');
        } else {
            let quote = '';
            end = -1;
            for (let j = i + 1; j < text.length; j++) {
                const ch = text[j];
                if (quote) { if (ch === quote) quote = ''; }
                else if (ch === '"' || ch === '\'') quote = ch;
                else if (ch === '>') { end = j + 1; break; }
            }
            if (end === -1) throw fail('a tag is not closed.');
            const tag = text.slice(i, end);
            if (tag.startsWith('</')) {
                preserve.pop();
            } else if (!tag.endsWith('/>')) {
                const space = /\sxml:space\s*=\s*(["'])(preserve|default)\1/.exec(tag);
                const inherited = preserve[preserve.length - 1] ?? false;
                preserve.push(space ? space[2] === 'preserve' : inherited);
            }
        }
        out.push(text.slice(i, end));
        i = end;
    }
    return out.join('');
}
