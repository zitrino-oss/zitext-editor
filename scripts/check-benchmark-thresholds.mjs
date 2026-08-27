import fs from 'node:fs';

const thresholdsNs = {
  read_file_10KB: 10_000_000,
  read_file_500KB: 50_000_000,
  read_file_5MB: 300_000_000,
  write_file_1MB: 500_000_000,
  search_file_1MB: 100_000_000,
  read_directory_200_files: 100_000_000,
  validate_path: 10_000_000,
};

const BENCH_VALUE = /bench:\s+([0-9,.]+)\s+ns\/iter/;
const TEST_LINE = /^test\s/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a benchmark's ns/iter measurement.
 *
 * Criterion prints "test <name> ... " and its "bench: N ns/iter" result to
 * stdout, but writes diagnostics to stderr — for example the missing-baseline
 * warning emitted whenever target/criterion has no previous run (a cold cache,
 * or the first run after a cache key changes). When a caller merges the two
 * streams, that diagnostic lands between the two halves and pushes the result
 * onto the following line, so the pair cannot be matched as a single line.
 *
 * Scanning forward from the test line handles both layouts.
 */
function findMeasurement(lines, name) {
  const testLine = new RegExp(`^test\\s+${escapeRegExp(name)}\\s`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!testLine.test(lines[i])) continue;
    for (let j = i; j < lines.length; j += 1) {
      // Stop at the next benchmark. A genuinely missing result has to be
      // reported, never silently satisfied by the next benchmark's number.
      if (j > i && TEST_LINE.test(lines[j])) break;
      const match = lines[j].match(BENCH_VALUE);
      if (match) return match[1];
    }
    return null;
  }
  return null;
}

const path = process.argv[2] ?? 'bench-output.txt';
const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
let failed = false;

for (const [name, maximum] of Object.entries(thresholdsNs)) {
  const raw = findMeasurement(lines, name);
  if (raw === null) {
    console.error(`Missing benchmark result: ${name}`);
    failed = true;
    continue;
  }
  const measured = Number(raw.replaceAll(',', ''));
  if (!Number.isFinite(measured) || measured > maximum) {
    console.error(`${name}: ${measured} ns exceeds ${maximum} ns`);
    failed = true;
  } else {
    console.log(`${name}: ${measured} ns (limit ${maximum} ns)`);
  }
}

if (failed) process.exit(1);
