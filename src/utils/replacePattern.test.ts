import { describe, expect, it } from 'vitest';
import { expandReplacement } from './replacePattern';

// Regex replacement used to insert "$1" literally.
describe('expandReplacement', () => {
    const groups = ['john@example', 'john', 'example'];

    it('is literal outside regex mode', () => {
        expect(expandReplacement('$2 at $1\\n', groups, false)).toBe('$2 at $1\\n');
    });

    it('expands capture groups, the whole match and $$', () => {
        expect(expandReplacement('$2 at $1', groups, true)).toBe('example at john');
        expect(expandReplacement('[$&] [$0]', groups, true)).toBe('[john@example] [john@example]');
        expect(expandReplacement('cost: $$5', groups, true)).toBe('cost: $5');
        expect(expandReplacement('$9|', groups, true)).toBe('|');
        expect(expandReplacement('trailing $', groups, true)).toBe('trailing $');
    });

    it('supports two-digit groups when they exist', () => {
        const many = ['m', ...Array.from({ length: 11 }, (_, i) => `<${i + 1}>`)];
        expect(expandReplacement('$10-$11', many, true)).toBe('<10>-<11>');
        // There is no group 12, so this is group 1 followed by a literal "2".
        expect(expandReplacement('$12', many, true)).toBe('<1>2');
    });

    it('expands escape sequences', () => {
        expect(expandReplacement('a\\nb\\tc\\\\d\\x', groups, true)).toBe('a\nb\tc\\d\\x');
    });
});
