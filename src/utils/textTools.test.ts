import { describe, expect, it } from 'vitest';
import {
    applyCodec, changeCase, convertDelimited, countUniqueLines, dateToUnix, decodeJwt, delimitedToJson,
    formatDelimited, formatLineCounts, jsonToDelimited, md5Hex, minifyXml, parseDelimited, sha256Hex,
    splitLines, transformLines, unixToIso,
} from './textTools';

describe('line tools', () => {
    it('sorts alphabetically, ignoring case first, and stays stable', () => {
        expect(transformLines(['banana', 'Apple', 'cherry', 'apple', 'Écharpe'], 'sortAsc'))
            .toEqual(['Apple', 'apple', 'banana', 'cherry', 'Écharpe']);
        expect(transformLines(['b', 'a', 'c'], 'sortDesc')).toEqual(['c', 'b', 'a']);
    });

    it('sorts by the first number, lines without one last in their order', () => {
        expect(transformLines(['id 10', 'none', 'id -3.5', 'id 2e1', 'id 2', 'also none', 'x .5'], 'sortNumeric'))
            .toEqual(['id -3.5', 'x .5', 'id 2', 'id 10', 'id 2e1', 'none', 'also none']);
    });

    it('removes duplicates, empty lines and runs of blank lines', () => {
        expect(transformLines(['a', 'b', 'a', 'c', 'b'], 'dedupe')).toEqual(['a', 'b', 'c']);
        expect(transformLines(['a', '', '  ', 'b', '\t'], 'removeEmpty')).toEqual(['a', 'b']);
        expect(transformLines(['a', '', ' ', '', 'b', ' ', 'c'], 'collapseEmpty')).toEqual(['a', '', 'b', ' ', 'c']);
    });

    it('trims, reverses and joins', () => {
        expect(transformLines(['  a  ', '\tb'], 'trimLeading')).toEqual(['a  ', 'b']);
        expect(transformLines(['  a  ', 'b\t'], 'trimTrailing')).toEqual(['  a', 'b']);
        expect(transformLines(['  a  '], 'trimBoth')).toEqual(['a']);
        expect(transformLines(['1', '2', '3'], 'reverse')).toEqual(['3', '2', '1']);
        expect(transformLines(['  one', '', 'two  ', 'three'], 'join')).toEqual(['one two three']);
        expect(transformLines([], 'join')).toEqual(['']);
    });

    it('never changes its input', () => {
        const lines = ['b', 'a'];
        transformLines(lines, 'sortAsc');
        expect(lines).toEqual(['b', 'a']);
    });

    it('splits lines at a delimiter', () => {
        expect(splitLines(['a, b,c', 'd'], ',')).toEqual(['a', ' b', 'c', 'd']);
        expect(splitLines(['a, b,c'], ',', true)).toEqual(['a', 'b', 'c']);
        expect(() => splitLines(['a'], '')).toThrow('Enter a delimiter to split on.');
    });

    it('counts unique lines, most frequent first', () => {
        const counts = countUniqueLines(['x', 'y', 'x', 'z', 'y', 'x']);
        expect(counts).toEqual([{ line: 'x', count: 3 }, { line: 'y', count: 2 }, { line: 'z', count: 1 }]);
        expect(formatLineCounts(counts, 6)).toBe('6 lines, 3 unique\n\n3\tx\n2\ty\n1\tz');
    });
});

describe('case', () => {
    it('converts case, with title case keeping words like "don\'t" whole', () => {
        expect(changeCase('Ünïcode ok', 'upper')).toBe('ÜNÏCODE OK');
        expect(changeCase('MiXeD', 'lower')).toBe('mixed');
        expect(changeCase("don't STOP me-now (please) o'brien", 'title')).toBe("Don't Stop Me-Now (Please) O'brien");
        expect(changeCase('"quoted" snake_case path/to', 'title')).toBe('"Quoted" Snake_Case Path/To');
        expect(changeCase('😀 émile', 'title')).toBe('😀 Émile');
    });
});

describe('encoding', () => {
    const roundTrip = (text: string, encode: Parameters<typeof applyCodec>[1], decode: Parameters<typeof applyCodec>[1]) =>
        expect(applyCodec(applyCodec(text, encode), decode)).toBe(text);

    it('round-trips every codec, including emoji and accents', () => {
        const sample = 'Héllo wörld & <tag> "q" \'s\' 😀 a+b=c/d?e#f\n\ttab';
        roundTrip(sample, 'urlEncode', 'urlDecode');
        roundTrip(sample, 'base64Encode', 'base64Decode');
        roundTrip(sample, 'htmlEscape', 'htmlUnescape');
        roundTrip(sample, 'jsonEscape', 'jsonUnescape');
    });

    it('URL-decodes + as a space and rejects broken input', () => {
        expect(applyCodec('a+b%20c', 'urlDecode')).toBe('a b c');
        expect(() => applyCodec('%E0%A4%A', 'urlDecode')).toThrow("This isn't valid URL-encoded text.");
    });

    it('reads URL-safe Base64, missing padding and line breaks', () => {
        expect(applyCodec('aGk/Pz8=', 'base64Decode')).toBe('hi???');
        expect(applyCodec('aGk_Pz8', 'base64Decode')).toBe('hi???');
        expect(applyCodec('aGVs\nbG8=', 'base64Decode')).toBe('hello');
        expect(() => applyCodec('not base64!', 'base64Decode')).toThrow("This isn't valid Base64.");
        expect(() => applyCodec('/w==', 'base64Decode')).toThrow("The decoded data isn't text (not valid UTF-8).");
    });

    it('unescapes named and numeric entities, leaving unknown ones', () => {
        expect(applyCodec('&lt;b&gt; &amp;amp; &copy; &#169; &#xA9; &bogus; &#xD800; &#1114112;', 'htmlUnescape'))
            .toBe('<b> &amp; © © © &bogus; &#xD800; &#1114112;');
        expect(applyCodec(`<a href="x">'</a>`, 'htmlEscape')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;');
    });

    it('JSON-unescapes with or without the quotes', () => {
        expect(applyCodec('line\\nnext \\"q\\" \\u00e9', 'jsonUnescape')).toBe('line\nnext "q" é');
        expect(applyCodec('"a\\tb"', 'jsonUnescape')).toBe('a\tb');
        expect(() => applyCodec('bad \\x', 'jsonUnescape')).toThrow("This isn't a valid JSON string.");
    });
});

describe('checksums', () => {
    it('MD5 matches the RFC 1321 test suite and non-ASCII text', () => {
        expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
        expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
        expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
        expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
        expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
        expect(md5Hex('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
        expect(md5Hex('1234567890'.repeat(8))).toBe('57edf4a22be3c955ac49da2e2107b67a');
        // Expected values from Node's crypto; 55, 56 and 64 bytes cross the padding boundaries.
        expect(md5Hex('Grüße, 世界 😀')).toBe('93db5baa80a64ccbd08617f4ebcb96a5');
        expect(md5Hex('x'.repeat(55))).toBe('04364420e25c512fd958a70738aa8f72');
        expect(md5Hex('x'.repeat(56))).toBe('668a72d5ba17f08e62dabcafad6db14b');
        expect(md5Hex('x'.repeat(64))).toBe('c1bb4f81d892b2d57947682aeb252456');
        expect(md5Hex('y'.repeat(100_000))).toBe('f0a7af634b47967c6cf3a0aaaaa50d17');
    });

    it('SHA-256 matches', async () => {
        expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(await sha256Hex('Grüße 😀')).toBe('3436cf1c2f912923eb6c58432bc973f1e3bf57852f000822b53954e45e6c5be4');
        expect(await sha256Hex('z'.repeat(70_000))).toBe('c466389580aea5a288efb4f6e7961e68077fc5295e3e9222d9abee4a34b99a05');
    });
});

describe('dates', () => {
    it('reads seconds, milliseconds, microseconds and fractions', () => {
        expect(unixToIso('1696700000')).toBe('2023-10-07T17:33:20Z');
        expect(unixToIso(' 1696700000123 ')).toBe('2023-10-07T17:33:20.123Z');
        expect(unixToIso('1696700000123456')).toBe('2023-10-07T17:33:20.123Z');
        expect(unixToIso('1696700000.5')).toBe('2023-10-07T17:33:20.500Z');
        expect(unixToIso('-86400')).toBe('1969-12-31T00:00:00Z');
        expect(unixToIso('0')).toBe('1970-01-01T00:00:00Z');
        for (const bad of ['abc', '12345678901234', '1e9', '', '99999999999999999']) {
            expect(() => unixToIso(bad)).toThrow("This isn't a Unix timestamp.");
        }
    });

    it('reads ISO 8601, RFC 2822 and slashed dates; no zone means UTC', () => {
        expect(dateToUnix('2023-10-07T17:33:20Z')).toBe('1696700000');
        expect(dateToUnix('2023-10-07 17:33:20')).toBe('1696700000');
        expect(dateToUnix('2023-10-07T19:33:20+02:00')).toBe('1696700000');
        expect(dateToUnix('2023-10-07T12:33:20-0500')).toBe('1696700000');
        expect(dateToUnix('2023-10-07T17:33:20.25Z')).toBe('1696700000.25');
        expect(dateToUnix('2023-10-07')).toBe('1696636800');
        expect(dateToUnix('Sat, 07 Oct 2023 17:33:20 GMT')).toBe('1696700000');
        expect(dateToUnix('7 Oct 2023 19:33:20 +0200')).toBe('1696700000');
        expect(dateToUnix('2023/10/07 17:33')).toBe('1696699980');
        for (const bad of ['2023-02-30', '2023-13-01', 'yesterday', '07/10/2023', '2023-10-07T25:00']) {
            expect(() => dateToUnix(bad)).toThrow("This isn't a date ZITEXT can read.");
        }
    });
});

describe('JWT', () => {
    const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'u1', exp: 1696700000, iat: 1696696400, name: 'Zoë' })}.c2ln`;

    it('decodes header and claims locally, with readable times', () => {
        const decoded = JSON.parse(decodeJwt(`Bearer ${token}`));
        expect(decoded.header).toEqual({ alg: 'HS256', typ: 'JWT' });
        expect(decoded.payload.name).toBe('Zoë');
        expect(decoded.signature).toBe('present, not verified');
        expect(decoded.times).toEqual({ exp: '2023-10-07T17:33:20Z', iat: '2023-10-07T16:33:20Z' });
        expect(JSON.parse(decodeJwt(token.split('.').slice(0, 2).join('.') + '.')).signature).toBe('none');
    });

    it('rejects anything else', () => {
        for (const bad of ['abc', 'a.b.c.d', `${encode([1])}.${encode({})}`, 'e30.notbase64!']) {
            expect(() => decodeJwt(bad)).toThrow("This isn't a JSON Web Token.");
        }
    });
});

describe('CSV and TSV', () => {
    it('parses quotes, escaped quotes, delimiters and line breaks inside fields', () => {
        expect(parseDelimited('﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nx,\n', ','))
            .toEqual([['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['x', '']]);
        expect(parseDelimited('a\tb\n\nc', '\t')).toEqual([['a', 'b'], [''], ['c']]);
        expect(parseDelimited('', ',')).toEqual([]);
        expect(() => parseDelimited('a\n"open,b', ',')).toThrow('A quoted field is not closed (row 2).');
    });

    it('quotes only where needed and round-trips random data', () => {
        expect(formatDelimited([['a', 'b,c', 'say "x"', ' pad', 'multi\nline']], ',', '\n'))
            .toBe('a,"b,c","say ""x"""," pad","multi\nline"');
        let seed = 3;
        const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const alphabet = ['a', 'b', ',', '"', '\n', '\r\n', ' ', '\t', 'é'];
        for (let run = 0; run < 300; run++) {
            const rows = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
                Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
                    Array.from({ length: Math.floor(random() * 5) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')));
            for (const delimiter of [',', '\t']) {
                expect(parseDelimited(formatDelimited(rows, delimiter, '\r\n'), delimiter)).toEqual(rows);
            }
        }
    });

    it('converts CSV to JSON with header rules, keeping values as text', () => {
        expect(JSON.parse(delimitedToJson('id,,id,zip\n007,x,y,01234,extra\n8', ','))).toEqual([
            { id: '007', column_2: 'x', id_2: 'y', zip: '01234', column_5: 'extra' },
            { id: '8', column_2: '', id_2: '', zip: '' },
        ]);
        expect(delimitedToJson('only,header', ',')).toBe('[]');
    });

    it('converts JSON to CSV from objects, arrays or one object', () => {
        expect(jsonToDelimited('[{"a":1,"b":{"c":true}},{"b":null,"d":"x,y"}]', ',', '\n'))
            .toBe('a,b,d\n1,"{""c"":true}",\n,,"x,y"');
        expect(jsonToDelimited('[[1,"two"],[3]]', '\t', '\n')).toBe('1\ttwo\n3');
        expect(jsonToDelimited('{"k":"v"}', ',', '\n')).toBe('k\nv');
        expect(() => jsonToDelimited('[1,2]', ',', '\n')).toThrow('Convert to CSV needs a JSON array of objects or of arrays.');
        expect(() => jsonToDelimited('{bad', ',', '\n')).toThrow(/^Invalid JSON/);
    });

    it('converts between CSV and TSV correctly quoted', () => {
        expect(convertDelimited('a,"b\tc",d\n', ',', '\t', '\n')).toBe('a\t"b\tc"\td');
        expect(convertDelimited('a\t"x,y"', '\t', ',', '\n')).toBe('a,"x,y"');
    });
});

describe('Minify XML', () => {
    it('removes whitespace between tags and keeps everything else as written', () => {
        const xml = `<?xml version="1.0"?>\n<!DOCTYPE r [ <!ENTITY e "x > y"> ]>\n<r a="  spaced  ">\n  <!--  keep   me  -->\n  <t>  text stays  </t>\n  <![CDATA[  <raw>  ]]>\n  <p xml:space="preserve">  <q>  </q>  </p>\n  <e/>\n</r>\n`;
        const minified = minifyXml(xml);
        expect(minified).toBe('<?xml version="1.0"?><!DOCTYPE r [ <!ENTITY e "x > y"> ]><r a="  spaced  "><!--  keep   me  --><t>  text stays  </t><![CDATA[  <raw>  ]]><p xml:space="preserve">  <q>  </q>  </p><e/></r>');
        expect(minifyXml(minified)).toBe(minified);
    });

    it('reports unterminated markup', () => {
        expect(() => minifyXml('<a><!-- x')).toThrow('Unable to minify XML: a comment is not closed.');
        expect(() => minifyXml('<a b="1"')).toThrow('Unable to minify XML: a tag is not closed.');
    });
});

describe('large inputs', () => {
    it('sorts and minifies 5 MB quickly', () => {
        const lines = Array.from({ length: 200_000 }, (_, i) => `line ${(i * 7919) % 200_000} payload`);
        const xml = '<root>' + '\n  <item a="1">value</item>'.repeat(200_000) + '\n</root>';
        const started = performance.now();
        expect(transformLines(lines, 'sortNumeric')[0]).toBe('line 0 payload');
        expect(minifyXml(xml).length).toBeLessThan(xml.length);
        expect(performance.now() - started).toBeLessThan(2000);
    });
});

describe('conversion and sorting edge cases', () => {
    it('keeps JSON numbers exactly as written in CSV', () => {
        expect(jsonToDelimited('[{"id":12345678901234567890,"p":1.10,"e":1e2,"n":{"x":1.50}}]', ',', '\n'))
            .toBe('id,p,e,n\n12345678901234567890,1.10,1e2,"{""x"":1.5}"');
        expect(jsonToDelimited('[[0.10, -2E3, "s"]]', ',', '\n')).toBe('0.10,-2E3,s');
    });

    it('keeps spaces that are content when minifying XML', () => {
        expect(minifyXml('<p><b>a</b> <i>b</i></p>')).toBe('<p><b>a</b> <i>b</i></p>');
        expect(minifyXml('<r>\n  <sep> </sep>\n</r>')).toBe('<r><sep> </sep></r>');
    });

    it('reads a hyphen after a word as a hyphen, not a minus', () => {
        expect(transformLines(['id-10', 'id-2', 'id-1', 'temp -5'], 'sortNumeric')).toEqual(['temp -5', 'id-1', 'id-2', 'id-10']);
    });

    it('reads TSV quotes leniently', () => {
        expect(convertDelimited('"Quoted" title\tx\n', '\t', ',', '\n')).toBe('"""Quoted"" title",x');
        expect(parseDelimited('"open\tx\nnext\ty', '\t')).toEqual([['"open', 'x'], ['next', 'y']]);
        expect(() => parseDelimited('"open,x', ',')).toThrow('A quoted field is not closed');
    });

    it('keeps a __proto__ column and skips blank lines in CSV to JSON', () => {
        expect(delimitedToJson('__proto__,b\n1,2\n\n', ',')).toBe('[\n  {\n    "__proto__": "1",\n    "b": "2"\n  }\n]');
    });

    it('converts years before 100 correctly', () => {
        expect(dateToUnix('0050-01-01T00:00:00Z')).toBe('-60589296000');
        expect(dateToUnix('0004-02-29')).toBe('-62035891200');
        expect(() => dateToUnix('0003-02-29')).toThrow();
    });
});

describe('large inputs for conversions', () => {
    it('converts a CSV with more rows than a function call can take as arguments', () => {
        const csv = 'id,name\n' + Array.from({ length: 150_000 }, (_, i) => `${i},n${i}`).join('\n');
        const records = JSON.parse(delimitedToJson(csv, ','));
        expect(records).toHaveLength(150_000);
        expect(records[149_999]).toEqual({ id: '149999', name: 'n149999' });
    });
});
