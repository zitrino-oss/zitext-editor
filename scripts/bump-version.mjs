#!/usr/bin/env node
/**
 * Single-command version bump for ZITEXT Editor.
 *
 *   node scripts/bump-version.mjs <version>      # e.g. 2.1.5
 *   npm run bump 2.1.5
 *
 * Updates every place the version lives so they never drift again:
 *   - src-tauri/tauri.conf.json   (the authoritative app version)
 *   - package.json
 *   - src-tauri/Cargo.toml        ([package] version)
 *   - src-tauri/Cargo.lock        (the zitext-editor crate entry)
 *   - CHANGELOG.md                (adds a dated [x.y.z] section + footer links)
 *
 * It does NOT commit, tag, or push — review the diff, then:
 *   git checkout -b release/vX.Y.Z && git commit -am "release: X.Y.Z" && open a PR
 * After the PR merges, run the "Release Build" workflow with the same version.
 * The website (downloads + docs) reads the version from the published
 * release manifest, so it updates automatically — no website edit needed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/zitrino-oss/zitext-editor';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('Usage: node scripts/bump-version.mjs <semver>   (e.g. 2.1.5)');
    process.exit(1);
}

const log = (f, msg) => console.log(`  ✓ ${f.padEnd(28)} ${msg}`);

function edit(rel, fn) {
    const path = join(ROOT, rel);
    const before = readFileSync(path, 'utf8');
    const after = fn(before);
    if (after === before) {
        console.warn(`  ! ${rel.padEnd(28)} no change (pattern not found?)`);
        return;
    }
    writeFileSync(path, after);
}

// --- config files -----------------------------------------------------------
edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
log('src-tauri/tauri.conf.json', `version -> ${version}`);

edit('package.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
log('package.json', `version -> ${version}`);

edit('src-tauri/Cargo.toml', (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`));
log('src-tauri/Cargo.toml', `version -> ${version}`);

edit('src-tauri/Cargo.lock', (s) =>
    s.replace(/(name = "zitext-editor"\nversion = ")[^"]+(")/, `$1${version}$2`));
log('src-tauri/Cargo.lock', `zitext-editor -> ${version}`);

// --- CHANGELOG.md ------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local node, allowed)
edit('CHANGELOG.md', (s) => {
    let out = s;
    // 1) Insert a dated section under [Unreleased] (skip if it already exists).
    if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(out)) {
        out = out.replace(
            /## \[Unreleased\]\s*\n/,
            `## [Unreleased]\n\n## [${version}] - ${today}\n\n### Added\n\n### Changed\n\n### Fixed\n\n`
        );
    }
    // 2) Footer links: point [Unreleased] at the new tag and add a tag link.
    out = out.replace(
        /\[Unreleased\]:\s*\S+/,
        `[Unreleased]: ${REPO}/compare/v${version}...HEAD`
    );
    if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]:`, 'm').test(out)) {
        out = out.replace(
            /(\[Unreleased\]:[^\n]*\n)/,
            `$1[${version}]: ${REPO}/releases/tag/v${version}\n`
        );
    }
    return out;
});
log('CHANGELOG.md', `added [${version}] - ${today} + footer links`);

console.log(`\nBumped to ${version}. Review the diff, fill in the CHANGELOG bullets,`);
console.log('commit on a branch, open a PR, then run the Release Build workflow with the same version.');
