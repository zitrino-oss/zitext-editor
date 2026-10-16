/**
 * Expands a Find/Replace replacement string for one match.
 *
 * In regex mode it supports the same tokens as VS Code:
 *   $0 / $&  the whole match        $1 … $99  capture groups
 *   $$       a literal "$"           \n  \t  \\  newline, tab, backslash
 * An unknown group number expands to an empty string. Outside regex mode the
 * replacement is inserted literally.
 *
 * `groups` is Monaco's FindMatch.matches: [whole match, group 1, group 2, ...].
 */
export function expandReplacement(template: string, groups: string[] | null, isRegex: boolean): string {
    if (!isRegex) return template;
    const whole = groups?.[0] ?? '';
    let out = '';
    for (let i = 0; i < template.length; i++) {
        const ch = template[i];
        const next = template[i + 1];
        if (ch === '\\' && next !== undefined) {
            if (next === 'n') { out += '\n'; i++; continue; }
            if (next === 't') { out += '\t'; i++; continue; }
            if (next === '\\') { out += '\\'; i++; continue; }
            out += ch;
            continue;
        }
        if (ch === '$' && next !== undefined) {
            if (next === '$') { out += '$'; i++; continue; }
            if (next === '&') { out += whole; i++; continue; }
            if (/[0-9]/.test(next)) {
                // Prefer a two-digit group if it exists ($10 with 10+ groups).
                const two = template.slice(i + 1, i + 3);
                if (/^[0-9]{2}$/.test(two) && groups && Number(two) < groups.length) {
                    out += groups[Number(two)] ?? '';
                    i += 2;
                    continue;
                }
                out += groups?.[Number(next)] ?? '';
                i++;
                continue;
            }
        }
        out += ch;
    }
    return out;
}
