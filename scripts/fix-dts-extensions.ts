import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Add `.js` extensions to relative specifiers in emitted declaration files.
 *
 * WHY THIS EXISTS
 * The source is written with extensionless relative imports, which is what
 * `moduleResolution: bundler` wants and what keeps 30 files readable. TypeScript
 * emits those specifiers into the `.d.ts` files verbatim. A consumer compiling
 * with `moduleResolution: node16` or `nodenext` then cannot resolve
 * `./localmind` and every exported type degrades to `any`.
 *
 * Rewriting the emitted declarations is the smallest fix that works for both
 * kinds of consumer: bundler-resolution users do not care about the extension,
 * and NodeNext users require it.
 *
 * A directory specifier (`./nodes` resolving to `./nodes/index`) would need
 * `/index.js` rather than `.js`, so the rewrite checks the filesystem instead of
 * assuming.
 */

const DIST = 'dist';

/** Matches the specifier in `from '...'` and `import('...')`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function resolveSpecifier(fileDir: string, specifier: string): Promise<string> {
  if (/\.(js|json|cjs|mjs)$/.test(specifier)) return specifier;
  if (await exists(join(fileDir, `${specifier}.d.ts`))) return `${specifier}.js`;
  if (await exists(join(fileDir, specifier, 'index.d.ts'))) return `${specifier}/index.js`;
  // Unresolvable: leave it alone rather than emit a broken path.
  return specifier;
}

const files = await walk(DIST);
let rewritten = 0;
let touched = 0;

for (const file of files) {
  const original = await Bun.file(file).text();
  const fileDir = join(file, '..');

  const replacements: { match: string; next: string }[] = [];
  for (const match of original.matchAll(SPECIFIER)) {
    const [whole, prefix, quote, specifier] = match;
    if (prefix === undefined || quote === undefined || specifier === undefined) continue;
    const resolved = await resolveSpecifier(fileDir, specifier);
    if (resolved !== specifier) {
      replacements.push({ match: whole, next: `${prefix}${quote}${resolved}${quote}` });
    }
  }

  if (replacements.length === 0) continue;

  let updated = original;
  for (const { match, next } of replacements) updated = updated.split(match).join(next);
  await Bun.write(file, updated);
  rewritten += replacements.length;
  touched += 1;
  process.stderr.write(`  ${relative(DIST, file)}  ${replacements.length} specifier(s)\n`);
}

process.stderr.write(`\nrewrote ${rewritten} specifier(s) across ${touched}/${files.length} declaration file(s)\n`);
