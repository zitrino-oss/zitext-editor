#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const budgets = [
    [/\/ts\.worker-[^/]+\.js$/, 7_200_000, 'TypeScript worker'],
    [/\/monaco-[^/]+\.js$/, 4_500_000, 'Monaco editor'],
    [/\/index-[^/]+\.js$/, 600_000, 'application'],
];

const assets = fs.readdirSync('dist/assets').map(name => {
    const file = path.join('dist/assets', name);
    return { file, size: fs.statSync(file).size };
});

for (const [pattern, maximum, label] of budgets) {
    const matches = assets.filter(asset => pattern.test(`/${asset.file}`));
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${label} asset, found ${matches.length}`);
    }
    if (matches[0].size > maximum) {
        throw new Error(`${label} is ${matches[0].size} bytes; budget is ${maximum}`);
    }
}

console.log('Bundle budgets passed.');
