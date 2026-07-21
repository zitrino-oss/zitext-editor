#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function compareSemver(left, right) {
    const a = SEMVER.exec(left);
    const b = SEMVER.exec(right);
    if (!a || !b) throw new Error(`Invalid semantic version: ${!a ? left : right}`);
    for (let index = 1; index <= 3; index += 1) {
        const difference = Number(a[index]) - Number(b[index]);
        if (difference !== 0) return Math.sign(difference);
    }
    const leftPre = a[4]?.split('.');
    const rightPre = b[4]?.split('.');
    if (!leftPre && !rightPre) return 0;
    if (!leftPre) return 1;
    if (!rightPre) return -1;
    for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
        if (leftPre[index] === undefined) return -1;
        if (rightPre[index] === undefined) return 1;
        if (leftPre[index] === rightPre[index]) continue;
        const leftNumeric = /^\d+$/.test(leftPre[index]);
        const rightNumeric = /^\d+$/.test(rightPre[index]);
        if (leftNumeric && rightNumeric) return Number(leftPre[index]) > Number(rightPre[index]) ? 1 : -1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPre[index] > rightPre[index] ? 1 : -1;
    }
    return 0;
}

export function verifyReleaseVersion(version, currentManifestPath) {
    if (!SEMVER.test(version)) throw new Error(`Invalid release version: ${version}`);
    const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    const tauriVersion = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
    const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
    const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
    const cargoLock = fs.readFileSync('src-tauri/Cargo.lock', 'utf8');
    const cargoLockVersion = /name = "zitext-editor"\nversion = "([^"]+)"/.exec(cargoLock)?.[1];
    for (const [source, sourceVersion] of [
        ['package.json', packageVersion],
        ['package-lock.json', packageLock.version],
        ['package-lock.json root package', packageLock.packages?.['']?.version],
        ['tauri.conf.json', tauriVersion],
        ['Cargo.toml', cargoVersion],
        ['Cargo.lock', cargoLockVersion],
    ]) {
        if (sourceVersion !== version) {
            throw new Error(`${source} is ${sourceVersion ?? 'missing'}, expected ${version}`);
        }
    }
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
    if (!changelog.includes(`## [${version}]`)) {
        throw new Error(`CHANGELOG.md has no [${version}] release section`);
    }

    if (currentManifestPath && fs.existsSync(currentManifestPath)) {
        const current = JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')).version;
        if (compareSemver(version, current) <= 0) {
            throw new Error(`Refusing to replace latest ${current} with non-newer ${version}`);
        }
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    try {
        verifyReleaseVersion(process.argv[2] ?? '', process.argv[3]);
        console.log(`Release version ${process.argv[2]} is valid and consistent.`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
