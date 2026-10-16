/* Short mono glyph + hue per language. Shared by the Language menu, which shows
   the glyph, and the status bar, which shows only the hue as a swatch.

   These hues are file-type identity colours, deliberately outside the theme
   token set — TypeScript blue means TypeScript in either theme, the same way
   the file-tree icon colours do. */
const LANG_BADGES: Record<string, [glyph: string, color: string]> = {
    html: ['<>', '#d97757'], css: ['#', '#5f8ae0'], javascript: ['JS', '#e0b33c'],
    typescript: ['TS', '#6f9cf5'], php: ['PHP', '#b48ded'], scss: ['SC', '#f2705f'],
    less: ['LE', '#5f8ae0'], coffeescript: ['CS', '#d97757'],
    handlebars: ['HB', '#d97757'], pug: ['PG', '#d97757'], razor: ['RZ', '#5f8ae0'],
    twig: ['TW', '#48c78e'], markdown: ['MD', '#8b93a1'],

    python: ['PY', '#5f8ae0'], java: ['JV', '#d97757'], csharp: ['C#', '#b48ded'],
    go: ['GO', '#54c7b8'], ruby: ['RB', '#f2705f'], swift: ['SW', '#d97757'],
    kotlin: ['KT', '#b48ded'], dart: ['DT', '#54c7b8'], elixir: ['EX', '#b48ded'],
    clojure: ['CJ', '#48c78e'],
    julia: ['JL', '#b48ded'], lua: ['LU', '#5f8ae0'], perl: ['PL', '#5f8ae0'],
    r: ['R', '#5f8ae0'], scala: ['SL', '#f2705f'], scheme: ['SM', '#8b93a1'],
    fsharp: ['F#', '#54c7b8'],

    c: ['C', '#5f8ae0'], cpp: ['C++', '#5f8ae0'], rust: ['RS', '#d97757'],
    'objective-c': ['OC', '#5f8ae0'], pascal: ['PA', '#5f8ae0'],
    verilog: ['VL', '#48c78e'], sol: ['SO', '#8b93a1'],

    json: ['{}', '#e0b33c'], xml: ['XM', '#d97757'], yaml: ['YM', '#f2705f'],
    toml: ['TM', '#8b93a1'], ini: ['IN', '#8b93a1'], sql: ['SQL', '#5f8ae0'],
    graphql: ['GQ', '#f2705f'], redis: ['RD', '#f2705f'],

    shell: ['SH', '#48c78e'], powershell: ['PS', '#5f8ae0'], bat: ['BT', '#8b93a1'],
    dockerfile: ['DK', '#5f8ae0'], makefile: ['MK', '#8b93a1'],
    plaintext: ['TXT', '#8b93a1'],

    mdx: ['MDX', '#8b93a1'], restructuredtext: ['RST', '#8b93a1'], liquid: ['LQ', '#48c78e'],
    freemarker2: ['FM', '#5f8ae0'],
    vb: ['VB', '#5f8ae0'], tcl: ['TCL', '#54c7b8'], apex: ['AX', '#5f8ae0'], abap: ['AB', '#5f8ae0'],
    qsharp: ['Q#', '#b48ded'], m3: ['M3', '#8b93a1'], sb: ['SB', '#5f8ae0'], postiats: ['ATS', '#f2705f'],
    ecl: ['ECL', '#5f8ae0'], flow9: ['F9', '#54c7b8'], cameligo: ['CL', '#48c78e'], pascaligo: ['PL', '#48c78e'],
    lexon: ['LX', '#8b93a1'], aes: ['AES', '#b48ded'],
    systemverilog: ['SV', '#48c78e'], mips: ['ASM', '#8b93a1'], wgsl: ['WG', '#d97757'], st: ['ST', '#5f8ae0'],
    mysql: ['MY', '#5f8ae0'], pgsql: ['PG', '#5f8ae0'], redshift: ['RS', '#f2705f'], sparql: ['SPQ', '#54c7b8'],
    cypher: ['CY', '#48c78e'], msdax: ['DAX', '#e0b33c'], powerquery: ['PQ', '#e0b33c'], proto: ['PB', '#54c7b8'],
    hcl: ['TF', '#b48ded'], bicep: ['BI', '#5f8ae0'], typespec: ['TSP', '#6f9cf5'], csp: ['CSP', '#8b93a1'],
    azcli: ['AZ', '#5f8ae0'], pla: ['PLA', '#8b93a1'],
};

/** Anything absent falls back to a neutral placeholder glyph and the muted token. */
export function languageBadge(id: string | null): [glyph: string, color: string] {
    return (id && LANG_BADGES[id]) || ['··', 'var(--text-muted)'];
}
