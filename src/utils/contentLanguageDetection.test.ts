/** Content language detection: accuracy and bounded cost. */
import { describe, expect, it } from 'vitest';
import { detectLanguageFromContent as detect } from './contentLanguageDetection';

describe('content language detection', () => {
    it.each([
        ['typescript', "import { useState } from 'react';\n\ninterface Props { name: string }\nexport function Hello({ name }: Props) {\n  return name;\n}"],
        ['javascript', "import fs from 'fs';\nconst data = fs.readFileSync('x');\nexport default data;"],
        ['java', 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}'],
        ['go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}'],
        ['kotlin', 'fun main() {\n    val name = "Kotlin"\n    println(name)\n}'],
        ['swift', 'import Foundation\n\nfunc greet(name: String) -> String {\n    return "Hi " + name\n}'],
        ['markdown', '# Notes\n\nSome text.\n\n```python\ndef main():\n    pass\n```\n'],
        ['xml', '<?xml version="1.0"?>\n<root><item id="1"/></root>'],
        ['xml', '<svg xmlns="http://www.w3.org/2000/svg" width="10"><rect/></svg>'],
        ['python', 'import os\n\n# load config\ndef main(path: str) -> None:\n    config = {\n        "a": 1,\n    }\n    print(os.path.exists(path))\n'],
        ['shell', '#!/bin/bash\necho "hello"\n'],
        ['json', '{"name": "zitext", "version": 2}'],
        ['yaml', 'openapi: 3.0.0\ncomponents:\n  schemas:\n    User:\n      type: object\n      properties:\n        name:\n          type: string\n'],
        ['rust', 'fn main() {\n    let mut x = 5;\n    println!("{}", x);\n}'],
    ])('%s', (language, text) => {
        expect(detect(text)).toBe(language);
    });

    it('returns nothing for ordinary prose', () => {
        expect(detect('Meeting notes: call Sam about the invoice tomorrow.')).toBeNull();
    });

    it('stays fast on a long unbroken token (was seconds per keystroke)', () => {
        const base64 = 'QUJD'.repeat(10_000) + ' {';
        const start = performance.now();
        for (let i = 0; i < 20; i++) detect(base64);
        expect((performance.now() - start) / 20).toBeLessThan(20);
    });
});
