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

const path = process.argv[2] ?? 'bench-output.txt';
const output = fs.readFileSync(path, 'utf8');
let failed = false;

for (const [name, maximum] of Object.entries(thresholdsNs)) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`test\\s+${escaped}\\s+.*?bench:\\s+([0-9,.]+)\\s+ns/iter`));
  if (!match) {
    console.error(`Missing benchmark result: ${name}`);
    failed = true;
    continue;
  }
  const measured = Number(match[1].replaceAll(',', ''));
  if (!Number.isFinite(measured) || measured > maximum) {
    console.error(`${name}: ${measured} ns exceeds ${maximum} ns`);
    failed = true;
  } else {
    console.log(`${name}: ${measured} ns (limit ${maximum} ns)`);
  }
}

if (failed) process.exit(1);
