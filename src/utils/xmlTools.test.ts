// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatXml, validateXml } from './xmlYamlTools';

describe('XML formatter', () => {
    it('preserves an XML declaration exactly', () => {
        const source = '<?xml version="1.0" encoding="UTF-8"?>\n<root><child>value</child></root>';
        expect(formatXml(source)).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
    });

    it('does not change mixed-content whitespace', () => {
        const source = '<p>Hello <strong>world</strong> and <em>friends</em>.</p>';
        expect(formatXml(source)).toBe(source);
    });

    it('preserves CDATA, comments, processing instructions, and quoted greater-than signs', () => {
        const source = '<?xml-stylesheet type="text/xsl" href="style.xsl"?>\n' +
            '<root test="a > b"><!-- note --><value><![CDATA[a < b && c > d]]></value></root>';
        const formatted = formatXml(source);
        expect(formatted).toContain('<?xml-stylesheet type="text/xsl" href="style.xsl"?>');
        // XMLSerializer may use the equivalent escaped representation.
        expect(formatted).toContain('test="a &gt; b"');
        expect(formatted).toContain('<!-- note -->');
        expect(formatted).toContain('<![CDATA[a < b && c > d]]>');
        expect(validateXml(formatted).valid).toBe(true);
    });

    it('preserves namespaces, doctypes, and semantic structure', () => {
        const source = '<!DOCTYPE root SYSTEM "root.dtd"><root xmlns:x="urn:test"><x:item id="1"/></root>';
        const formatted = formatXml(source);
        expect(formatted).toContain('<!DOCTYPE root SYSTEM "root.dtd">');
        expect(formatted).toContain('xmlns:x="urn:test"');
        expect(validateXml(formatted).valid).toBe(true);
    });

    it('honors inherited xml:space preserve whitespace', () => {
        const source = '<root xml:space="preserve">  <first/>\n    <second/>  </root>';
        expect(formatXml(source)).toBe(source);
    });

    it('refuses internal DTD subsets instead of silently dropping them', () => {
        const source = '<!DOCTYPE root [<!ENTITY author "Donald Duck">]><root>&author;</root>';
        expect(() => formatXml(source)).toThrow(/internal DTD subset.*left unchanged/i);
    });

    it('rejects malformed input without producing partial output', () => {
        expect(() => formatXml('<root><child></root>')).toThrow(/Failed to format XML/);
        expect(validateXml('<root><child></root>').valid).toBe(false);
    });
});
