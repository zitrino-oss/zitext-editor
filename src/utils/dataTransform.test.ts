import { describe, expect, it } from 'vitest';
import { applyDataTransform, preserveTextShape } from './dataTransform';
import { formatYaml } from './xmlYamlTools';

// Read-only documents, line endings / final newline, and YAML values that
// formatting would change.
describe('applyDataTransform', () => {
    const upper = (text: string) => text.toUpperCase();

    it('never changes a read-only document', () => {
        expect(applyDataTransform({ content: 'abc', isReadOnly: true }, upper)).toEqual({ kind: 'readOnly' });
    });

    it('applies the transform and reports errors instead of throwing', () => {
        expect(applyDataTransform({ content: 'abc', isReadOnly: false }, upper)).toEqual({ kind: 'changed', content: 'ABC' });
        expect(applyDataTransform({ content: 'ABC', isReadOnly: false }, upper)).toEqual({ kind: 'unchanged' });
        const failed = applyDataTransform({ content: '{', isReadOnly: false }, () => { throw new Error('bad'); });
        expect(failed.kind).toBe('error');
    });
});

describe('preserveTextShape', () => {
    it('keeps CRLF line endings and the final newline', () => {
        expect(preserveTextShape('a: 1\r\nb: 2\r\n', 'a: 1\nb: 2')).toBe('a: 1\r\nb: 2\r\n');
        expect(preserveTextShape('{"a":1}\n', '{\n  "a": 1\n}')).toBe('{\n  "a": 1\n}\n');
        expect(preserveTextShape('{"a":1}', '{\n  "a": 1\n}\n')).toBe('{\n  "a": 1\n}');
    });
});

describe('formatYaml keeps values exactly as written', () => {
    it('does not rewrite numbers, octal-looking values or big integers', () => {
        const source = [
            'big: 12345678901234567890',
            'mode:    0755',
            'zip: 01234',
            'hex: 0x1F',
            'exp: 1e3',
            'ratio: 1.50',
            'on: true',
            'none: ~',
            'quoted: "0755"',
        ].join('\n');
        const formatted = formatYaml(source);
        expect(formatted).toContain('big: 12345678901234567890');
        expect(formatted).toContain('mode: 0755');
        expect(formatted).toContain('zip: 01234');
        expect(formatted).toContain('hex: 0x1F');
        expect(formatted).toContain('exp: 1e3');
        expect(formatted).toContain('ratio: 1.50');
        expect(formatted).toContain('none: ~');
        expect(formatted).toContain('on: true');
        expect(formatted).toContain('quoted: "0755"');
    });

    it('still normalizes indentation, keeps comments and does not fold long lines', () => {
        const long = 'word '.repeat(40).trim();
        const formatted = formatYaml(`root:\n      child: 1   # note\nlong: ${long}\n`);
        expect(formatted).toBe(`root:\n  child: 1 # note\nlong: ${long}`);
    });

    it('honours the indent size', () => {
        expect(formatYaml('a:\n  b:\n    c: 1', 4)).toBe('a:\n    b:\n        c: 1');
    });
});
