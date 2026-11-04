/**
 * Static import/export checker for the browser bundle (and the server).
 *
 * The browser fails at *runtime* on a missing named export, which is slow to
 * catch by clicking around. This walks every ES module in `web/js` and
 * `server`, parses its import statements with a regex, and verifies each named
 * import actually exists in the target file's export list.
 *
 * Usage:  node scripts/check-imports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Collect every `.js` file under the given roots. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'web', 'js')), ...walk(path.join(ROOT, 'server'))];

/**
 * Replace comment and string *bodies* with spaces, preserving newlines and the
 * surrounding quotes/backticks. Handles escaped quotes, nested `${}` inside
 * template literals, and regex literals well enough for static analysis.
 */
function stripCommentsAndStrings(input) {
  const out = input.split('');
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      let end = input.indexOf('\n', i);
      if (end === -1) end = input.length;
      blank(i, end);
      i = end;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = input.indexOf('*/', i + 2);
      const stop = end === -1 ? input.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // Quoted string
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < input.length) {
        if (input[j] === '\\') {
          j += 2;
          continue;
        }
        if (input[j] === ch) break;
        if (input[j] === '\n') break; // unterminated
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }

    // Template literal
    if (ch === '`') {
      let j = i + 1;
      while (j < input.length) {
        if (input[j] === '\\') {
          j += 2;
          continue;
        }
        if (input[j] === '`') break;
        if (input[j] === '$' && input[j + 1] === '{') {
          // Recurse into the expression by recording where it ends.
          const exprStart = j + 2;
          let depth = 1;
          let k = exprStart;
          while (k < input.length && depth > 0) {
            if (input[k] === '\\') {
              k += 2;
              continue;
            }
            if (input[k] === '{') depth += 1;
            else if (input[k] === '}') depth -= 1;
            else if (input[k] === '`') {
              // Nested template: skip it wholesale.
              let m = k + 1;
              while (m < input.length) {
                if (input[m] === '\\') m += 2;
                else if (input[m] === '`') break;
                else m += 1;
              }
              k = m;
            }
            k += 1;
          }
          // Blank the literal chunk, leave the expression readable.
          blank(j, exprStart);
          j = k;
          continue;
        }
        j += 1;
      }
      blank(i + 1, Math.min(j, input.length));
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/** module path -> Set of exported names, or `'*'` when we cannot tell. */
const exportsCache = new Map();

function exportsOf(file) {
  const key = path.resolve(file);
  if (exportsCache.has(key)) return exportsCache.get(key);

  let source;
  try {
    source = fs.readFileSync(key, 'utf8');
  } catch {
    exportsCache.set(key, null);
    return null;
  }

  const names = new Set();
  let uncertain = false;

  for (const match of source.matchAll(
    /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const asMatch = cleaned.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const localMatch = cleaned.match(/^([A-Za-z_$][\w$]*)/);
      const name = asMatch ? asMatch[1] : localMatch ? localMatch[1] : null;
      if (name) names.add(name);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) names.add('default');
  if (/^\s*export\s+(?:async\s+)?function\s*\(/m.test(source)) uncertain = true;

  const result = uncertain ? '*' : names;
  exportsCache.set(key, result);
  return result;
}

const problems = [];
let checked = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);

  // `import ... from './x.js'` and bare `import './x.js'`
  const importRe = /^\s*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;

  for (const match of source.matchAll(importRe)) {
    const clause = (match[1] ?? '').trim();
    const specifier = match[2];
    if (!specifier.startsWith('.')) continue; // node: and npm packages

    const target = path.resolve(path.dirname(file), specifier);
    const available = exportsOf(target);
    if (!available || available === '*') continue;

    checked += 1;

    // `import Default, { a, b as c } from ...`
    const namedMatch = clause.match(/\{([\s\S]*)\}/);
    const defaultPart = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();

    if (defaultPart && !defaultPart.startsWith('*') && !available.has('default')) {
      problems.push(`${relative}: default import from ${specifier} but it has no default export`);
    }

    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const cleaned = part.trim();
        if (!cleaned) continue;
        const name = cleaned.split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!available.has(name)) {
          problems.push(`${relative}: "${name}" is not exported by ${specifier}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Second pass: identifiers that are exported *somewhere* in the project but
// neither imported nor declared in a file that uses them. This is what catches
// "frag is not defined" — a named helper that was simply forgotten in the
// import list, which the export check above cannot see.
// ---------------------------------------------------------------------------

const allExported = new Map(); // name -> Set of files exporting it
for (const file of files) {
  const names = exportsOf(file);
  if (!names || names === '*') continue;
  for (const name of names) {
    if (name === 'default') continue;
    if (!allExported.has(name)) allExported.set(name, new Set());
    allExported.get(name).add(path.relative(ROOT, file));
  }
}

// Names that are too generic to attribute to a single module with confidence.
const SKIP_NAMES = new Set([
  'state', 'logger', 'icon', 'route', 'navigate', 'buildUrl', 'refresh', 'startRouter',
  'subscribe', 'publish', 'count', 'percent', 'bytes', 'duration', 'truncate', 'uuid',
  'config', 'statusMeta', 'serverActions', 'PLATFORM_INFO', 'patchServer',
  // Generic names that are very often a method definition or a parameter.
  'on', 'getServer', 'off', 'emit', 'send', 'start', 'stop', 'close', 'update',
]);

let undefinedCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);

  // Blank out comments and string bodies so we only inspect real code.
  // A regex cannot do this correctly — nested template literals like
  // `` `'${x.replace(/'/g, `'\\''`)}'` `` defeat every non-greedy pattern — so
  // this is a single-pass scanner with proper string/template/comment state.
  const code = stripCommentsAndStrings(source);

  // NOTE: read imports from the *original* source — `code` has string literals
  // blanked out, which would erase the module specifiers we need to match.
  const imported = new Set();
  for (const match of source.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = match[1];
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const cleaned = part.trim();
        if (!cleaned) continue;
        imported.add(cleaned.split(/\s+as\s+/).pop().trim());
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/[*,\s]/g, '');
    if (def) imported.add(def);
  }

  // `const { a, b } = await import('./x.js')` — lazy imports still bind names,
  // so collect them too (they are legitimate, just deferred).
  for (const match of code.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(/g,
  )) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      imported.add(cleaned.split(/\s+as\s+/).pop().trim().split(':').pop().trim());
    }
  }
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(/g)) {
    imported.add(match[1]);
  }

  // Declared locally: functions, classes, consts, lets, params, destructuring.
  const declared = new Set(imported);
  for (const match of code.matchAll(
    /\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    declared.add(match[1]);
  }

  for (const [name, sources] of allExported) {
    if (SKIP_NAMES.has(name) || declared.has(name)) continue;
    // Only flag it when the name is unambiguous across the whole project.
    if (sources.size !== 1) continue;
    const usage = new RegExp(`(?<![.\\w$'"\`])${name}\\s*\\(`, 'g');
    if (!usage.test(code)) continue;
    undefinedCount += 1;
    problems.push(
      `${relative}: uses ${name}() but never imports it (exported only by ${[...sources][0]})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Third pass: elements that are built but never attached.
//
// `const foot = el('div.wizard__foot')` followed by ... nothing. The element
// (and every control inside it) then silently never appears in the UI. This
// shipped once — the entire Back/Continue/Create footer of the create wizard
// was invisible — so it is worth a static check.
//
// Heuristic: for each `const NAME = el(...)` at any indentation, look for
// NAME being referenced again in the same file. A single-element alias that is
// never mentioned twice is almost always a bug.
// ---------------------------------------------------------------------------

let orphans = 0;

for (const file of files) {
  const relative = path.relative(ROOT, file);
  const source = fs.readFileSync(file, 'utf8');

  for (const match of source.matchAll(/^[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*el\(/gm)) {
    const name = match[1];
    const after = source.slice(match.index + match[0].length);
    // Count identifier occurrences outside of the declaration itself.
    const uses = after.match(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, 'g'));
    if (!uses || uses.length === 0) {
      orphans += 1;
      problems.push(
        `${relative}: "${name}" is built with el() but never attached anywhere — it will not render`,
      );
    }
  }
}

if (problems.length) {
  console.error(`\n\x1b[31m✖ ${problems.length} problem(s):\x1b[0m`);
  for (const problem of problems) console.error(`  • ${problem}`);
  process.exit(1);
}

console.log(
  `\x1b[32m✔\x1b[0m ${files.length} modules scanned · ${checked} relative import(s) verified · ` +
    `${allExported.size} exported symbol(s) cross-checked · ` +
    `${orphans} orphaned element(s).`,
);
