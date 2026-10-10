/**
 * The one list of language modes. The Language menus (in-app
 * and native), the command palette, the status bar and file-name detection
 * all read it, and a test checks that every id is a language Monaco can
 * highlight and that the native menu in lib.rs offers exactly these ids.
 *
 * `extensions` include Monaco's own for each id, plus the file types ZITEXT
 * registers with the OS (tauri.conf.json). Extensions are lower case and
 * without the dot; `filenames` match whole file names exactly.
 */
export type LanguageGroup = 'web' | 'general' | 'systems' | 'data' | 'scripts';

export interface LanguageInfo {
    id: string;
    label: string;
    group: LanguageGroup;
    extensions: string[];
    filenames?: string[];
}

export const LANGUAGE_GROUPS: { id: LanguageGroup; label: string }[] = [
    { id: 'web', label: 'Web and Markup' },
    { id: 'general', label: 'General Programming' },
    { id: 'systems', label: 'Systems and Engineering' },
    { id: 'data', label: 'Data and Config' },
    { id: 'scripts', label: 'Scripts and Build' },
];

export const LANGUAGES: LanguageInfo[] = [
    // Web and Markup
    { id: 'html', label: 'HTML', group: 'web', extensions: ['html', 'htm', 'shtml', 'xhtml', 'mdoc', 'jsp', 'asp', 'aspx', 'jshtm'] },
    { id: 'css', label: 'CSS', group: 'web', extensions: ['css'] },
    { id: 'javascript', label: 'JavaScript', group: 'web', extensions: ['js', 'es6', 'jsx', 'mjs', 'cjs'], filenames: ['jakefile'] },
    { id: 'typescript', label: 'TypeScript', group: 'web', extensions: ['ts', 'tsx', 'cts', 'mts'] },
    { id: 'php', label: 'PHP', group: 'web', extensions: ['php', 'php4', 'php5', 'phtml', 'ctp'] },
    { id: 'scss', label: 'SCSS', group: 'web', extensions: ['scss'] },
    { id: 'less', label: 'Less', group: 'web', extensions: ['less'] },
    { id: 'coffeescript', label: 'CoffeeScript', group: 'web', extensions: ['coffee'] },
    { id: 'handlebars', label: 'Handlebars', group: 'web', extensions: ['handlebars', 'hbs'] },
    { id: 'pug', label: 'Pug', group: 'web', extensions: ['jade', 'pug'] },
    { id: 'razor', label: 'Razor', group: 'web', extensions: ['cshtml'] },
    { id: 'twig', label: 'Twig', group: 'web', extensions: ['twig'] },
    { id: 'markdown', label: 'Markdown', group: 'web', extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mkd', 'mdwn', 'mdtxt', 'mdtext'] },
    { id: 'mdx', label: 'MDX', group: 'web', extensions: ['mdx'] },
    { id: 'restructuredtext', label: 'reStructuredText', group: 'web', extensions: ['rst'] },
    { id: 'liquid', label: 'Liquid', group: 'web', extensions: ['liquid'] },
    { id: 'freemarker2', label: 'FreeMarker', group: 'web', extensions: ['ftl', 'ftlh', 'ftlx'] },

    // General Programming
    { id: 'python', label: 'Python', group: 'general', extensions: ['py', 'rpy', 'pyw', 'cpy', 'gyp', 'gypi'] },
    { id: 'java', label: 'Java', group: 'general', extensions: ['java', 'jav'] },
    { id: 'csharp', label: 'C#', group: 'general', extensions: ['cs', 'csx', 'cake'] },
    { id: 'go', label: 'Go', group: 'general', extensions: ['go'] },
    { id: 'ruby', label: 'Ruby', group: 'general', extensions: ['rb', 'rbx', 'rjs', 'gemspec'], filenames: ['rakefile', 'Rakefile', 'Gemfile'] },
    { id: 'swift', label: 'Swift', group: 'general', extensions: ['swift'] },
    { id: 'kotlin', label: 'Kotlin', group: 'general', extensions: ['kt', 'kts'] },
    { id: 'dart', label: 'Dart', group: 'general', extensions: ['dart'] },
    { id: 'elixir', label: 'Elixir', group: 'general', extensions: ['ex', 'exs'] },
    { id: 'clojure', label: 'Clojure', group: 'general', extensions: ['clj', 'cljs', 'cljc', 'edn'] },
    { id: 'julia', label: 'Julia', group: 'general', extensions: ['jl'] },
    { id: 'lua', label: 'Lua', group: 'general', extensions: ['lua'] },
    { id: 'perl', label: 'Perl', group: 'general', extensions: ['pl', 'pm', 'perl'] },
    { id: 'r', label: 'R', group: 'general', extensions: ['r', 'rhistory', 'rmd', 'rprofile', 'rt'] },
    { id: 'scala', label: 'Scala', group: 'general', extensions: ['scala', 'sc', 'sbt'] },
    { id: 'scheme', label: 'Scheme', group: 'general', extensions: ['scm', 'ss', 'sch', 'rkt'] },
    { id: 'fsharp', label: 'F#', group: 'general', extensions: ['fs', 'fsi', 'fsx', 'fsscript'] },
    { id: 'vb', label: 'Visual Basic', group: 'general', extensions: ['vb'] },
    { id: 'tcl', label: 'Tcl', group: 'general', extensions: ['tcl'] },
    // .cls stays Plain Text: it is also a LaTeX class file.
    { id: 'apex', label: 'Apex', group: 'general', extensions: [] },
    { id: 'abap', label: 'ABAP', group: 'general', extensions: ['abap'] },
    { id: 'qsharp', label: 'Q#', group: 'general', extensions: ['qs'] },
    { id: 'm3', label: 'Modula-3', group: 'general', extensions: ['m3', 'i3', 'mg', 'ig'] },
    { id: 'sb', label: 'Small Basic', group: 'general', extensions: ['sb'] },
    { id: 'postiats', label: 'ATS', group: 'general', extensions: ['dats', 'sats', 'hats'] },
    { id: 'ecl', label: 'ECL', group: 'general', extensions: ['ecl'] },
    { id: 'flow9', label: 'Flow9', group: 'general', extensions: ['flow'] },
    { id: 'cameligo', label: 'CameLIGO', group: 'general', extensions: ['mligo'] },
    { id: 'pascaligo', label: 'PascaLIGO', group: 'general', extensions: ['ligo'] },
    { id: 'lexon', label: 'Lexon', group: 'general', extensions: ['lex'] },
    { id: 'aes', label: 'AES (Sophia)', group: 'general', extensions: ['aes'] },

    // Systems and Engineering
    { id: 'c', label: 'C', group: 'systems', extensions: ['c', 'h'] },
    { id: 'cpp', label: 'C++', group: 'systems', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'] },
    { id: 'rust', label: 'Rust', group: 'systems', extensions: ['rs', 'rlib'] },
    { id: 'objective-c', label: 'Objective-C', group: 'systems', extensions: ['m'] },
    { id: 'pascal', label: 'Pascal', group: 'systems', extensions: ['pas', 'p', 'pp'] },
    { id: 'verilog', label: 'Verilog', group: 'systems', extensions: ['v', 'vh'] },
    { id: 'sol', label: 'Solidity', group: 'systems', extensions: ['sol'] },
    { id: 'systemverilog', label: 'SystemVerilog', group: 'systems', extensions: ['sv', 'svh'] },
    { id: 'mips', label: 'MIPS Assembly', group: 'systems', extensions: ['s'] },
    { id: 'wgsl', label: 'WGSL', group: 'systems', extensions: ['wgsl'] },
    { id: 'st', label: 'Structured Text', group: 'systems', extensions: ['st', 'iecst', 'iecplc', 'lc3lib'] },

    // Data and Config
    { id: 'json', label: 'JSON', group: 'data', extensions: ['json', 'jsonc', 'bowerrc', 'jshintrc', 'jscsrc', 'eslintrc', 'babelrc', 'har', 'webmanifest'] },
    { id: 'xml', label: 'XML', group: 'data', extensions: ['xml', 'xsd', 'dtd', 'ascx', 'csproj', 'config', 'props', 'targets', 'wxi', 'wxl', 'wxs', 'xaml', 'svg', 'svgz', 'opf', 'xslt', 'xsl', 'plist'] },
    { id: 'yaml', label: 'YAML', group: 'data', extensions: ['yaml', 'yml'] },
    { id: 'toml', label: 'TOML', group: 'data', extensions: ['toml'], filenames: ['Cargo.lock', 'Pipfile'] },
    { id: 'ini', label: 'INI', group: 'data', extensions: ['ini', 'properties', 'gitconfig', 'cfg', 'conf'], filenames: ['config', '.gitattributes', '.gitconfig', '.editorconfig'] },
    { id: 'sql', label: 'SQL', group: 'data', extensions: ['sql'] },
    { id: 'graphql', label: 'GraphQL', group: 'data', extensions: ['graphql', 'gql'] },
    { id: 'redis', label: 'Redis', group: 'data', extensions: ['redis'] },
    // .sql opens as SQL (listed first); these dialects are picked by hand.
    { id: 'mysql', label: 'MySQL', group: 'data', extensions: ['sql'] },
    { id: 'pgsql', label: 'PostgreSQL', group: 'data', extensions: ['sql'] },
    { id: 'redshift', label: 'Redshift', group: 'data', extensions: ['sql'] },
    { id: 'sparql', label: 'SPARQL', group: 'data', extensions: ['rq'] },
    { id: 'cypher', label: 'Cypher', group: 'data', extensions: ['cypher', 'cyp'] },
    { id: 'msdax', label: 'DAX', group: 'data', extensions: ['dax', 'msdax'] },
    { id: 'powerquery', label: 'Power Query', group: 'data', extensions: ['pq', 'pqm'] },
    { id: 'proto', label: 'Protocol Buffers', group: 'data', extensions: ['proto'] },
    { id: 'hcl', label: 'Terraform (HCL)', group: 'data', extensions: ['tf', 'tfvars', 'hcl'] },
    { id: 'bicep', label: 'Bicep', group: 'data', extensions: ['bicep'] },
    { id: 'typespec', label: 'TypeSpec', group: 'data', extensions: ['tsp'] },
    { id: 'csp', label: 'Content Security Policy', group: 'data', extensions: ['csp'] },

    // Scripts and Build
    { id: 'shell', label: 'Shell', group: 'scripts', extensions: ['sh', 'bash', 'zsh', 'fish', 'ksh'], filenames: ['.bashrc', '.zshrc', '.profile', '.bash_profile'] },
    { id: 'powershell', label: 'PowerShell', group: 'scripts', extensions: ['ps1', 'psm1', 'psd1'] },
    { id: 'bat', label: 'Batch', group: 'scripts', extensions: ['bat', 'cmd'] },
    { id: 'dockerfile', label: 'Dockerfile', group: 'scripts', extensions: ['dockerfile'], filenames: ['Dockerfile', 'Containerfile'] },
    { id: 'azcli', label: 'Azure CLI', group: 'scripts', extensions: ['azcli'] },
    { id: 'pla', label: 'PLA', group: 'scripts', extensions: ['pla'] },
    { id: 'makefile', label: 'Makefile', group: 'scripts', extensions: ['mk', 'mak'], filenames: ['Makefile', 'makefile', 'GNUmakefile'] },
    { id: 'plaintext', label: 'Plain Text', group: 'scripts', extensions: ['txt', 'log', 'text', 'csv', 'tsv'] },
];

const byId = new Map(LANGUAGES.map(language => [language.id, language]));
const byExtension = new Map<string, string>();
const byFileName = new Map<string, string>();
for (const language of LANGUAGES) {
    for (const extension of language.extensions) {
        if (!byExtension.has(extension)) byExtension.set(extension, language.id);
    }
    for (const name of language.filenames ?? []) byFileName.set(name, language.id);
}

export function languageInfo(id: string): LanguageInfo | undefined {
    return byId.get(id);
}

/** Language for a file path: exact file name first (Dockerfile, Makefile),
 *  then the extension; Plain Text when neither is known. */
export function languageForPath(filePath: string | null): string {
    if (!filePath) return 'plaintext';
    const name = filePath.split(/[/\\]/).pop() ?? '';
    const named = byFileName.get(name);
    if (named) return named;
    // "Dockerfile.dev", "app.Dockerfile"
    if (/^dockerfile\./i.test(name)) return 'dockerfile';
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'plaintext';
    return byExtension.get(name.slice(dot + 1).toLowerCase()) ?? 'plaintext';
}

export function languageLabel(id: string): string {
    return byId.get(id)?.label ?? 'Plain Text';
}

/** The usual extension for a language, for naming a new file. */
export function extensionForLanguage(id: string): string {
    return byId.get(id)?.extensions[0] ?? 'txt';
}

/** Languages the Markdown preview can render. Other files keep the editor. */
export function canPreviewMarkdown(language: string | null | undefined): boolean {
    return language === 'markdown' || language === 'mdx';
}

/** A tab shows the rendered preview only while it is Markdown: a session saved
 *  before preview was limited, or a language change, must not leave a code
 *  file rendered as Markdown. */
export function showsPreview(tab: { isPreview?: boolean; language: string }): boolean {
    return !!tab.isPreview && canPreviewMarkdown(tab.language);
}

/**
 * JSON files that allow comments and trailing commas by convention
 * (tsconfig, VS Code settings, *.jsonc). Validated and formatted as such.
 */
export function isJsoncPath(filePath: string | null): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/');
    const name = normalized.split('/').pop() ?? '';
    return /\.jsonc$/i.test(name)
        || /^(tsconfig|jsconfig)(\..*)?\.json$/i.test(name)
        || /^\.?(eslintrc|babelrc|jshintrc|swcrc)(\.json)?$/i.test(name)
        || /^(devcontainer|\.devcontainer)\.json$/i.test(name)
        || /(^|\/)\.vscode\/[^/]+\.json$/i.test(normalized);
}
