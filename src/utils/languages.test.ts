// @vitest-environment jsdom
/**
 * One language registry: every mode offered is one
 * Monaco can highlight, the native and in-app menus offer the same modes,
 * and the file types ZITEXT registers with the OS open in a real mode.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (document as unknown as { queryCommandSupported: () => boolean }).queryCommandSupported = () => false;
    window.matchMedia ??= ((query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

import * as monaco from 'monaco-editor';
import nativeMenuSource from '../../src-tauri/src/lib.rs?raw';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import { LANGUAGES, isJsoncPath, languageForPath, languageLabel } from './languages';
import { registerExtraLanguages } from './extraLanguages';
import { languageBadge } from './languageBadges';

registerExtraLanguages(monaco);
const ids = LANGUAGES.map(language => language.id);

describe('language registry', () => {
    it('offers only modes Monaco can highlight', () => {
        const registered = new Set(monaco.languages.getLanguages().map(language => language.id));
        expect(ids.filter(id => !registered.has(id))).toEqual([]);
    });

    it('matches the native Language menu exactly', () => {
        const native = [...nativeMenuSource.matchAll(/\("lang-([\w-]+)",/g)].map(match => match[1]);
        expect([...native].sort()).toEqual([...ids].sort());
    });

    it('has a badge and a label for every mode', () => {
        for (const id of ids) {
            expect(languageBadge(id)[0], id).not.toBe('··');
            expect(languageLabel(id), id).not.toBe(id === 'plaintext' ? '' : 'Plain Text');
        }
    });

    it('opens the file types ZITEXT is associated with in a real mode', () => {
        const plainOnPurpose = new Set(['txt', 'log', 'csv', 'tex', 'sty', 'cls', 'sass']);
        const associated = tauriConfig.bundle.fileAssociations.flatMap(association => association.ext);
        const unmapped = associated.filter(ext => !plainOnPurpose.has(ext) && languageForPath(`file.${ext}`) === 'plaintext');
        expect(unmapped).toEqual([]);
    });

    it('detects names and extensions Monaco supports', () => {
        expect(languageForPath('/app/Dockerfile')).toBe('dockerfile');
        expect(languageForPath('/app/Makefile')).toBe('makefile');
        expect(languageForPath('/app/main.dart')).toBe('dart');
        expect(languageForPath('/app/index.mjs')).toBe('javascript');
        expect(languageForPath('/app/Contract.sol')).toBe('sol');
        expect(languageForPath('/app/Cargo.toml')).toBe('toml');
        expect(languageLabel('dart')).toBe('Dart');
        // Monaco's other built-in languages are offered too.
        expect(languageForPath('/infra/main.tf')).toBe('hcl');
        expect(languageForPath('/api/user.proto')).toBe('proto');
        expect(languageForPath('/rtl/core.sv')).toBe('systemverilog');
        expect(languageForPath('/docs/index.rst')).toBe('restructuredtext');
        expect(languageForPath('/db/schema.sql')).toBe('sql');
        expect(languageForPath('/tex/article.cls')).toBe('plaintext');
        expect(LANGUAGES.length).toBeGreaterThanOrEqual(80);
    });

    it('highlights TOML and Makefile', () => {
        const toml = monaco.editor.tokenize('[package]\nname = "zitext" # comment', 'toml');
        expect(toml[0].some(token => token.type.startsWith('type'))).toBe(true);
        const make = monaco.editor.tokenize('build: main.o\n\t$(CC) -o app main.o', 'makefile');
        expect(make[1].some(token => token.type.startsWith('variable'))).toBe(true);
    });

    it('recognises JSON files that allow comments', () => {
        expect(isJsoncPath('/p/tsconfig.json')).toBe(true);
        expect(isJsoncPath('/p/tsconfig.app.json')).toBe(true);
        expect(isJsoncPath('C:\\p\\.vscode\\settings.json')).toBe(true);
        expect(isJsoncPath('/p/data.jsonc')).toBe(true);
        expect(isJsoncPath('/p/package.json')).toBe(false);
    });
});
