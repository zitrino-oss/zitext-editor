import { describe, expect, it } from 'vitest';
import {
    formatJson,
    minifyJson,
    sortJsonKeys,
    validateJson,
} from './jsonTools';
import { formatYaml } from './xmlYamlTools';

describe('lossless JSON tools', () => {
    it('preserves integers beyond JavaScript safe-number precision', () => {
        const source = '{"id":9007199254740993123456789,"small":1}';
        expect(formatJson(source)).toContain('9007199254740993123456789');
        expect(minifyJson(formatJson(source))).toBe(source);
    });

    it('retains __proto__ as ordinary document data while sorting', () => {
        const result = sortJsonKeys('{"z":1,"__proto__":{"polluted":true},"a":2}');
        expect(result).toContain('"__proto__":');
        expect(result.indexOf('"__proto__"')).toBeLessThan(result.indexOf('"a"'));
        expect(result.indexOf('"a"')).toBeLessThan(result.indexOf('"z"'));
    });

    it('rejects JSON comments and trailing commas', () => {
        expect(validateJson('{/* comment */"a":1}').valid).toBe(false);
        expect(validateJson('{"a":1,}').valid).toBe(false);
    });

    it('preserves escaped string lexemes while minifying', () => {
        const source = '{ \n "text" : "a\\u0062\\n" , "ok" : true \n}';
        expect(minifyJson(source)).toBe('{"text":"a\\u0062\\n","ok":true}');
    });
});

describe('YAML formatter', () => {
    it('preserves quoted comment and colon characters', () => {
        const source = 'url: "https://example.test/a:b#c"\nnote: "# not a comment"\n';
        const formatted = formatYaml(source);
        expect(formatted).toContain('https://example.test/a:b#c');
        expect(formatted).toContain('# not a comment');
    });

    it('rejects malformed YAML instead of emitting partial output', () => {
        expect(() => formatYaml('value: [1, 2')).toThrow(/Failed to format YAML/);
    });
});
