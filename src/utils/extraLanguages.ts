/**
 * Small syntax grammars for common file types Monaco does not ship:
 * TOML and Makefile. Highlighting only; no language services.
 */
import type * as Monaco from 'monaco-editor';

const toml: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenizer: {
        root: [
            [/#.*$/, 'comment'],
            [/^\s*\[\[[^\]]*\]\]/, 'type'],
            [/^\s*\[[^\]]*\]/, 'type'],
            [/[A-Za-z0-9_.-]+(?=\s*=)/, 'key'],
            [/"([^"\\]|\\.)*"(?=\s*=)/, 'key'],
            [/"""/, 'string', '@mlBasic'],
            [/'''/, 'string', '@mlLiteral'],
            [/"([^"\\]|\\.)*"/, 'string'],
            [/'[^']*'/, 'string'],
            [/\b(true|false)\b/, 'keyword'],
            [/\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?)?/, 'number'],
            [/[+-]?(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?|inf|nan)\b/, 'number'],
            [/[=,{}[\]]/, 'delimiter'],
        ],
        mlBasic: [
            [/"""/, 'string', '@pop'],
            [/[^"]+/, 'string'],
            [/"/, 'string'],
        ],
        mlLiteral: [
            [/'''/, 'string', '@pop'],
            [/[^']+/, 'string'],
            [/'/, 'string'],
        ],
    },
};

const makefile: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenizer: {
        root: [
            [/#.*$/, 'comment'],
            [/^\s*(ifeq|ifneq|ifdef|ifndef|else|endif|include|-include|sinclude|define|endef|export|unexport|override|vpath)\b/, 'keyword'],
            [/^\s*\.?[A-Za-z0-9_./%-]+(?=\s*[:?+!]?=)/, 'variable'],
            [/^[^:#=\s][^:#=]*(?=::?(?!=))/, 'type'],
            [/\$[({][^)}]*[)}]/, 'variable'],
            [/\$[@<^?*%+|$]/, 'variable'],
            [/"([^"\\]|\\.)*"|'[^']*'/, 'string'],
            [/[:?+!]?=|::?/, 'operator'],
        ],
    },
};

export function registerExtraLanguages(monaco: typeof Monaco): void {
    const known = new Set(monaco.languages.getLanguages().map(language => language.id));
    if (!known.has('toml')) {
        monaco.languages.register({ id: 'toml', extensions: ['.toml'], aliases: ['TOML'] });
        monaco.languages.setMonarchTokensProvider('toml', toml);
        monaco.languages.setLanguageConfiguration('toml', {
            comments: { lineComment: '#' },
            brackets: [['[', ']'], ['{', '}']],
            autoClosingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
        });
    }
    if (!known.has('makefile')) {
        monaco.languages.register({ id: 'makefile', extensions: ['.mk', '.mak'], filenames: ['Makefile', 'makefile', 'GNUmakefile'], aliases: ['Makefile'] });
        monaco.languages.setMonarchTokensProvider('makefile', makefile);
        monaco.languages.setLanguageConfiguration('makefile', { comments: { lineComment: '#' } });
    }
}
