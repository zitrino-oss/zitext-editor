/**
 * VS Code–style file/folder icons using inline SVGs.
 * Each icon is a small colored SVG matching the Seti/Material icon conventions.
 */

const ICON_SIZE = 16;

function Icon({ color, children }: { color: string; children: React.ReactNode }) {
    return (
        <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <g fill={color}>{children}</g>
        </svg>
    );
}

// ── Folder icons ──────────────────────────────────────────────────────

export function FolderIcon({ open }: { open?: boolean }) {
    if (open) return (
        <Icon color="#dcb67a">
            <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V6H7.5L6 4H1.5V2z" opacity="0.9"/>
            <path d="M0 6h16v6.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 010 12.5V6z"/>
        </Icon>
    );
    return (
        <Icon color="#dcb67a">
            <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.5L6 2H1.5z"/>
        </Icon>
    );
}

// Special folder colors
const FOLDER_COLORS: Record<string, string> = {
    'src': '#42a5f5', 'lib': '#42a5f5', 'app': '#42a5f5',
    'node_modules': '#8d6e63', '.git': '#f4511e',
    'dist': '#66bb6a', 'build': '#66bb6a', 'out': '#66bb6a',
    'test': '#ab47bc', 'tests': '#ab47bc', '__tests__': '#ab47bc', 'spec': '#ab47bc',
    'public': '#26a69a', 'static': '#26a69a', 'assets': '#26a69a',
    'config': '#78909c', '.vscode': '#42a5f5', '.github': '#78909c',
    'components': '#42a5f5', 'hooks': '#7e57c2', 'utils': '#78909c',
    'styles': '#ec407a', 'types': '#42a5f5',
};

export function FolderIconNamed({ name, open }: { name: string; open?: boolean }) {
    const color = FOLDER_COLORS[name.toLowerCase()] || '#dcb67a';
    if (open) return (
        <Icon color={color}>
            <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V6H7.5L6 4H1.5V2z" opacity="0.9"/>
            <path d="M0 6h16v6.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 010 12.5V6z"/>
        </Icon>
    );
    return (
        <Icon color={color}>
            <path d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0014.5 4H7.5L6 2H1.5z"/>
        </Icon>
    );
}

// ── File icons ────────────────────────────────────────────────────────

function FileBase({ color, letter }: { color: string; letter?: string }) {
    return (
        <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
            <path d="M3 1h7l4 4v9a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z" fill={color} opacity="0.15"/>
            <path d="M3 1h7l4 4v9a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z" stroke={color} strokeWidth="1"/>
            <path d="M10 1v4h4" stroke={color} strokeWidth="1"/>
            {letter && <text x="8" y="12" textAnchor="middle" fontSize="6.5" fontWeight="700" fontFamily="system-ui" fill={color}>{letter}</text>}
        </svg>
    );
}

// Extension → {color, letter} mapping
const FILE_ICON_MAP: Record<string, { color: string; letter?: string }> = {
    // JavaScript / TypeScript
    js:    { color: '#f5de19', letter: 'JS' },
    jsx:   { color: '#00d8ff', letter: 'JX' },
    ts:    { color: '#3178c6', letter: 'TS' },
    tsx:   { color: '#3178c6', letter: 'TX' },
    mjs:   { color: '#f5de19', letter: 'MJ' },
    cjs:   { color: '#f5de19', letter: 'CJ' },
    mts:   { color: '#3178c6', letter: 'MT' },

    // Python
    py:    { color: '#3776ab', letter: 'Py' },
    pyx:   { color: '#3776ab', letter: 'Py' },

    // Rust
    rs:    { color: '#ce422b', letter: 'Rs' },

    // Go
    go:    { color: '#00add8', letter: 'Go' },

    // Java / Kotlin / Scala
    java:  { color: '#e76f00', letter: 'Ja' },
    kt:    { color: '#7f52ff', letter: 'Kt' },
    kts:   { color: '#7f52ff', letter: 'Kt' },
    scala: { color: '#dc322f', letter: 'Sc' },

    // C-family
    c:     { color: '#a8b9cc', letter: 'C' },
    h:     { color: '#a8b9cc', letter: 'H' },
    cpp:   { color: '#00599c', letter: 'C+' },
    cxx:   { color: '#00599c', letter: 'C+' },
    hpp:   { color: '#00599c', letter: 'H+' },
    cs:    { color: '#68217a', letter: 'C#' },

    // Swift / ObjC
    swift: { color: '#f05138', letter: 'Sw' },
    m:     { color: '#438eff', letter: 'OC' },

    // Ruby / PHP / Perl
    rb:    { color: '#cc342d', letter: 'Rb' },
    php:   { color: '#777bb3', letter: 'PH' },
    pl:    { color: '#39457e', letter: 'Pl' },
    pm:    { color: '#39457e', letter: 'Pm' },

    // Lua / R
    lua:   { color: '#000080', letter: 'Lu' },
    r:     { color: '#276dc3', letter: 'R' },

    // Web
    html:  { color: '#e44d26', letter: '<>' },
    htm:   { color: '#e44d26', letter: '<>' },
    css:   { color: '#264de4', letter: '#' },
    scss:  { color: '#cd6799', letter: 'Sc' },
    sass:  { color: '#cd6799', letter: 'Sa' },
    less:  { color: '#1d365d', letter: 'Le' },
    vue:   { color: '#42b883', letter: 'V' },
    svelte:{ color: '#ff3e00', letter: 'Sv' },

    // Data / Config
    json:  { color: '#f5de19', letter: '{}' },
    jsonc: { color: '#f5de19', letter: '{}' },
    yaml:  { color: '#cb171e', letter: 'YA' },
    yml:   { color: '#cb171e', letter: 'YA' },
    toml:  { color: '#9c4221', letter: 'TM' },
    xml:   { color: '#e44d26', letter: 'XM' },
    csv:   { color: '#237346', letter: 'CS' },
    tsv:   { color: '#237346', letter: 'TV' },
    ini:   { color: '#78909c', letter: 'IN' },
    env:   { color: '#ecd53f', letter: 'EN' },

    // Markup / Docs
    md:    { color: '#42a5f5', letter: 'MD' },
    mdx:   { color: '#f9ac00', letter: 'MX' },
    txt:   { color: '#78909c' },
    rtf:   { color: '#78909c', letter: 'RT' },
    tex:   { color: '#008080', letter: 'TX' },
    rst:   { color: '#78909c', letter: 'rS' },

    // Shell
    sh:    { color: '#4eaa25', letter: '$' },
    bash:  { color: '#4eaa25', letter: '$' },
    zsh:   { color: '#4eaa25', letter: '$' },
    fish:  { color: '#4eaa25', letter: '$' },
    ps1:   { color: '#012456', letter: 'PS' },
    bat:   { color: '#c1f12e', letter: 'BA' },
    cmd:   { color: '#c1f12e', letter: 'CM' },

    // Docker / CI
    dockerfile: { color: '#2496ed', letter: 'DK' },

    // SQL
    sql:   { color: '#e38c00', letter: 'SQ' },

    // Lock / package
    lock:  { color: '#78909c', letter: 'LK' },

    // Git
    gitignore:    { color: '#f4511e', letter: 'GI' },
    gitattributes:{ color: '#f4511e', letter: 'GA' },

    // Images (won't open, but show icon)
    png:   { color: '#66bb6a', letter: 'PN' },
    jpg:   { color: '#66bb6a', letter: 'JP' },
    jpeg:  { color: '#66bb6a', letter: 'JP' },
    gif:   { color: '#66bb6a', letter: 'GI' },
    svg:   { color: '#ffb300', letter: 'SV' },
    ico:   { color: '#66bb6a', letter: 'IC' },
    webp:  { color: '#66bb6a', letter: 'WP' },

    // Archives
    zip:   { color: '#78909c', letter: 'ZP' },
    tar:   { color: '#78909c', letter: 'TR' },
    gz:    { color: '#78909c', letter: 'GZ' },

    // Binary
    exe:   { color: '#78909c', letter: 'EX' },
    dll:   { color: '#78909c', letter: 'DL' },
    so:    { color: '#78909c', letter: 'SO' },
    dylib: { color: '#78909c', letter: 'DY' },
    wasm:  { color: '#654ff0', letter: 'WA' },
};

// Special full-name matches
const FILENAME_MAP: Record<string, { color: string; letter?: string }> = {
    'Dockerfile':      { color: '#2496ed', letter: 'DK' },
    'Makefile':        { color: '#6d8086', letter: 'MK' },
    'CMakeLists.txt':  { color: '#6d8086', letter: 'CM' },
    'Cargo.toml':      { color: '#ce422b', letter: 'Rs' },
    'Cargo.lock':      { color: '#ce422b', letter: 'Rs' },
    'package.json':    { color: '#cb3837', letter: 'NP' },
    'package-lock.json':{ color: '#cb3837', letter: 'NP' },
    'tsconfig.json':   { color: '#3178c6', letter: 'TS' },
    '.gitignore':      { color: '#f4511e', letter: 'GI' },
    '.env':            { color: '#ecd53f', letter: 'EN' },
    '.env.local':      { color: '#ecd53f', letter: 'EN' },
    'LICENSE':         { color: '#d4aa00', letter: 'LI' },
    'README.md':       { color: '#42a5f5', letter: 'RM' },
};

export function FileIcon({ name }: { name: string }) {
    // Check full filename match first
    const byName = FILENAME_MAP[name];
    if (byName) return <FileBase color={byName.color} letter={byName.letter} />;

    // Then check extension
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const byExt = FILE_ICON_MAP[ext];
    if (byExt) return <FileBase color={byExt.color} letter={byExt.letter} />;

    // Default file icon
    return <FileBase color="#78909c" />;
}

/** Returns a React element for use in tabs */
export function getFileIconElement(fileName: string, isDirectory: boolean, expanded?: boolean): React.ReactNode {
    if (isDirectory) return <FolderIconNamed name={fileName} open={expanded} />;
    return <FileIcon name={fileName} />;
}
