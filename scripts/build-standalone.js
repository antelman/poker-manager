/**
 * Bundle the app into a single self-contained HTML file.
 *
 *   node scripts/build-standalone.js
 *
 * Produces:
 *   dist/poker.html     a full page you can open straight off disk or email
 *                       to someone; no server, no build step, no network
 *   dist/embed.html     the same page as body content only, for hosts that
 *                       supply their own <html>/<head> wrapper
 *
 * The modules are concatenated rather than bundled by a tool: there are a
 * handful of them, the dependency order is fixed, and adding a bundler to a
 * project with no dependencies would cost more than it saves. Every module
 * app.js imports has to be listed here - one that is missing only shows up as
 * a ReferenceError once the page is open.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFile(join(ROOT, file), 'utf8');

/** Strip ES module syntax so the pieces can run as one classic script. */
function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(default\s+)?(function|const|let|var|class))/gm, '')
    .trim();
}

/** Drop the service-worker registration; there is no sw.js next to one file. */
function stripServiceWorker(source) {
  return source.replace(/\/\* sw:start[\s\S]*?\/\* sw:end \*\//, '');
}

/**
 * Top-level names declared in a chunk, so the build can refuse to merge two
 * modules that both define one.
 *
 * Separate modules may each have their own `emptyState`; concatenated into a
 * single scope one silently wins and the other's callers break at runtime.
 * Catching it here turns that into a build error.
 */
function topLevelNames(source) {
  const names = new Set();
  for (const line of source.split('\n')) {
    const match = /^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function assertNoCollisions(chunks) {
  const seen = new Map();
  const clashes = [];

  for (const [name, source] of chunks) {
    for (const declared of topLevelNames(source)) {
      if (seen.has(declared)) {
        clashes.push(`${declared} (${seen.get(declared)} and ${name})`);
      } else {
        seen.set(declared, name);
      }
    }
  }

  if (clashes.length > 0) {
    throw new Error(
      `Cannot bundle: these top-level names are declared in more than one module:\n  ${clashes.join('\n  ')}\nRename one of each pair.`
    );
  }
}

/**
 * Replace every `url("fonts/x.woff2")` in the stylesheet with a base64 data
 * URI. Missing a file is a build error rather than a silent fallback to the
 * system font, which is exactly the failure this is here to prevent.
 */
async function inlineFonts(css) {
  const references = [...css.matchAll(/url\("(fonts\/[^"]+\.woff2)"\)/g)];
  if (references.length === 0) {
    throw new Error('No fonts/*.woff2 references found in styles.css; the bundle would render in the system font.');
  }

  let inlined = css;
  for (const [match, file] of references) {
    const data = await readFile(join(ROOT, file));
    inlined = inlined.replace(match, `url("data:font/woff2;base64,${data.toString('base64')}")`);
  }
  return inlined;
}

/**
 * Refuse to ship a bundle that is missing a module app.js imports. Stripping
 * the import lines hides the mistake until the page throws a ReferenceError in
 * front of a table full of people.
 */
function assertNothingMissing(appSource, bundled) {
  const imported = [...appSource.matchAll(/from\s+['"]\.\/(src\/[\w.-]+\.js)['"]/g)].map((m) => m[1]);
  const missing = imported.filter((file) => !bundled.includes(file));
  if (missing.length > 0) {
    throw new Error(
      `Cannot bundle: app.js imports ${missing.join(', ')}, which the build does not include.\nAdd them to the chunk list.`
    );
  }
}

async function build() {
  const [html, css, engine, store, sync, vision, watch, deck, app] = await Promise.all([
    read('index.html'),
    read('styles.css'),
    read('src/engine.js'),
    read('src/store.js'),
    read('src/sync.js'),
    read('src/vision.js'),
    read('src/table-watch.js'),
    read('src/deck.js'),
    read('app.js'),
  ]);

  const chunks = [
    ['src/engine.js', stripModuleSyntax(engine)],
    ['src/store.js', stripModuleSyntax(store)],
    ['src/sync.js', stripModuleSyntax(sync)],
    ['src/vision.js', stripModuleSyntax(vision)],
    ['src/table-watch.js', stripModuleSyntax(watch)],
    ['src/deck.js', stripModuleSyntax(deck)],
    ['app.js', stripModuleSyntax(stripServiceWorker(app))],
  ];

  assertNothingMissing(app, chunks.map(([name]) => name));
  assertNoCollisions(chunks);
  const script = chunks.map(([, source]) => source).join('\n\n');

  // Everything between <body> and the module script tag is the markup.
  const body = html
    .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script type="module"'))
    .trim();

  // A single file that needs the network for its typefaces is not standalone,
  // so the woff2 subsets are baked into the stylesheet as data URIs.
  const bundled = `<style>\n${await inlineFonts(css)}\n</style>\n\n${body}\n\n<script>\n${script}\n</script>\n`;

  const full = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1512">
<title>ערב פוקר</title>
</head>
<body>
${bundled}</body>
</html>
`;

  // Hosts that wrap the content themselves get the direction set at runtime,
  // since there is no <html> tag here to carry dir="rtl".
  const embed = `<title>ערב פוקר</title>
<script>
  document.documentElement.lang = 'he';
  document.documentElement.dir = 'rtl';
</script>
${bundled}`;

  await mkdir(join(ROOT, 'dist'), { recursive: true });
  await writeFile(join(ROOT, 'dist/poker.html'), full);
  await writeFile(join(ROOT, 'dist/embed.html'), embed);

  const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;
  console.log(`dist/poker.html  ${kb(full)}`);
  console.log(`dist/embed.html  ${kb(embed)}`);
}

build();
