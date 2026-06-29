// Language detection based on file extension
const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',

    // Web
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',

    // Data formats
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',

    // Programming languages
    py: 'python',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',

    // Shell/Scripts
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    ps1: 'powershell',
    bat: 'bat',
    cmd: 'bat',

    // Markup/Documentation
    md: 'markdown',
    markdown: 'markdown',
    tex: 'latex',

    // Config
    ini: 'ini',
    cfg: 'ini',
    conf: 'ini',

    // Database
    sql: 'sql',

    // Other
    txt: 'plaintext',
    log: 'plaintext',
    r: 'r',
    lua: 'lua',
    perl: 'perl',
    pl: 'perl',
};

export function detectLanguage(filePath: string | null): string {
    if (!filePath) return 'plaintext';

    const extension = filePath.split('.').pop()?.toLowerCase();
    if (!extension) return 'plaintext';

    return languageMap[extension] || 'plaintext';
}

export function getLanguageDisplayName(language: string): string {
    const displayNames: Record<string, string> = {
        javascript: 'JavaScript',
        typescript: 'TypeScript',
        html: 'HTML',
        css: 'CSS',
        scss: 'SCSS',
        sass: 'Sass',
        less: 'Less',
        json: 'JSON',
        xml: 'XML',
        yaml: 'YAML',
        toml: 'TOML',
        python: 'Python',
        java: 'Java',
        c: 'C',
        cpp: 'C++',
        csharp: 'C#',
        go: 'Go',
        rust: 'Rust',
        ruby: 'Ruby',
        php: 'PHP',
        swift: 'Swift',
        kotlin: 'Kotlin',
        scala: 'Scala',
        shell: 'Shell',
        powershell: 'PowerShell',
        bat: 'Batch',
        markdown: 'Markdown',
        latex: 'LaTeX',
        ini: 'INI',
        sql: 'SQL',
        plaintext: 'Plain Text',
        r: 'R',
        lua: 'Lua',
        perl: 'Perl',
    };

    return displayNames[language] || 'Plain Text';
}
