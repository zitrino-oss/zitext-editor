/**
 * Guesses the language of an untitled document from its text.
 *
 * - Looks at the first few KB only, with patterns that cannot backtrack
 *   across the whole buffer, so a large paste stays cheap.
 * - Checks strong, language-specific signals first (shebangs, `<?php`,
 *   `package main`, TypeScript annotations…) before broad ones, so
 *   TypeScript, Java or Markdown with a code fence are not called Python.
 * - Returns null when unsure; the caller keeps Plain Text.
 */
const SAMPLE_CHARS = 4096;
const MIN_CHARS = 10;

type Rule = [language: string, test: (sample: string) => boolean];

const has = (pattern: RegExp) => (sample: string) => pattern.test(sample);
const count = (pattern: RegExp, sample: string) => (sample.match(pattern) ?? []).length;

const SHEBANGS: [RegExp, string][] = [
    [/^#!.*\bpython[\d.]*\b/, 'python'],
    [/^#!.*\b(node|deno|bun)\b/, 'javascript'],
    [/^#!.*\b(ruby)\b/, 'ruby'],
    [/^#!.*\bperl\b/, 'perl'],
    [/^#!.*\b(pwsh|powershell)\b/, 'powershell'],
    [/^#!.*\b(ba|z|k|da)?sh\b/, 'shell'],
];

const RULES: Rule[] = [
    ['php', has(/<\?php\b/)],
    ['xml', has(/^\s*<\?xml\b|^\s*<svg\b/i)],
    ['html', has(/^\s*<!doctype html|<html[\s>]|<(head|body|div|span|script|p)[\s>][^]{0,2000}<\/\1>/i)],
    // A code fence is Markdown even when the fenced code is Python or JS.
    ['markdown', has(/^```[\w-]*\s*$/m)],
    ['typescript', has(/^\s*(export\s+)?(interface|type|enum)\s+\w+[\s<={]|\b\w+\??\s*:\s*(string|number|boolean|void|unknown|never)(\[\])?\s*[;,)=]|\bimport\s+type\b|\bas\s+const\b/m)],
    ['go', s => /^package\s+\w+\s*$/m.test(s) && /^func\s/m.test(s)],
    ['rust', has(/^\s*(pub\s+)?fn\s+\w+\s*[(<]|\blet\s+mut\b|\bimpl(<[^>\n]{0,80}>)?\s+\w+|\b(println|eprintln|print|format|vec|panic|assert|assert_eq|write|writeln)!\s*[([]|^\s*use\s+(std|crate)::/m)],
    ['java', s => /^\s*(public|private|protected)\s+(final\s+)?(class|interface|enum|record)\s+\w+/m.test(s) || s.includes('System.out.print')],
    ['csharp', s => /^\s*using\s+System\b|^\s*namespace\s+[\w.]+\s*[{;]/m.test(s) || /Console\.Write(Line)?\(/.test(s)],
    ['kotlin', has(/^\s*fun\s+\w+\s*\(|^\s*(val|var)\s+\w+\s*[:=]|^\s*data\s+class\s/m)],
    ['swift', has(/^\s*import\s+(Foundation|SwiftUI|UIKit)\b|^\s*func\s+\w+\s*\([^)\n]{0,200}\)\s*->/m)],
    ['cpp', has(/#include\s*<(iostream|vector|string|map|memory)>|\bstd::|^\s*namespace\s+\w+\s*\{|\btemplate\s*</m)],
    ['c', has(/^\s*#include\s*[<"][\w./]+\.h[>"]|^\s*int\s+main\s*\(/m)],
    ['javascript', has(/^\s*(import\s+[\w{*][^\n]{0,200}\sfrom\s+['"]|export\s+(default\s+)?(function|class|const)\b|const\s+\w+\s*=\s*(require\(|\(|async\b)|module\.exports\b)|\bconsole\.log\(|=>\s*[{(]|\bdocument\.\w+/m)],
    ['python', s => count(/^\s*(def\s+\w+\s*\([^)\n]{0,200}\)\s*(->\s*[\w[\], .]{1,60})?:|class\s+\w+(\([^)\n]{0,100}\))?:|from\s+[\w.]+\s+import\s|import\s+[\w.]+\s*$|if\s+__name__\s*==|elif\s.{0,200}:)/gm, s) >= 1],
    ['ruby', has(/^\s*(require\s+['"]|module\s+[A-Z]\w*\s*$|def\s+\w+[?!]?\s*$|puts\s)/m)],
    ['sql', has(/^\s*(SELECT\s[^\n]{0,200}\sFROM\s|INSERT\s+INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|CREATE\s+(TABLE|INDEX|VIEW)\s|ALTER\s+TABLE\s)/im)],
    ['css', s => count(/^\s*[.#]?[\w-][\w\s.#:>,-]{0,100}\{[^{}\n]{0,200}$/gm, s) >= 1
        && /^\s*[\w-]{1,40}\s*:\s*[^;\n]{1,200};\s*$/m.test(s)],
    ['shell', has(/^\s*(echo|export|cd|sudo|apt(-get)?|brew|npm|yarn|pip|git)\s/m)],
    // Headings and lists come late: "# text" is also a comment in Python and shell.
    ['markdown', s => count(/^(#{1,6} \S|[-*] \S|\d+\. \S)/gm, s) >= 2],
    ['yaml', s => /^---\s*$/m.test(s) || count(/^[\w-]{1,60}:(\s|$)/gm, s) >= 2 && !/[;{}]\s*$/m.test(s)],
];

function isJson(text: string): boolean {
    const trimmed = text.trim();
    if (!/^[{[]/.test(trimmed) || !/[}\]]$/.test(trimmed)) return false;
    // Parsing is linear, but keep it to reasonably sized documents.
    if (trimmed.length > 1_000_000) return /^[{[]\s*["{[\d]/.test(trimmed);
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

export function detectLanguageFromContent(content: string): string | null {
    if (!content || content.trim().length < MIN_CHARS) return null;
    if (isJson(content)) return 'json';

    const sample = content.slice(0, SAMPLE_CHARS).replace(/^﻿/, '');
    const firstLine = sample.slice(0, sample.indexOf('\n') >>> 0);
    for (const [pattern, language] of SHEBANGS) {
        if (pattern.test(firstLine)) return language;
    }
    for (const [language, test] of RULES) {
        if (test(sample)) return language;
    }
    return null;
}
