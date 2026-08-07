// Every icon the UI asks for must exist in the vendored set.
//
// The icon set is first-party SVG data URIs used as CSS masks (assets/icons.css,
// which replaced the FontAwesome CDN for INV-4). A class the file does not
// define is not an error: the element renders as a 1em blank square, nothing
// throws, and nothing is logged. Five of them were live on screen - the
// lightbulb on every orphaned startup row among them - until an audit went
// looking. No DOM test catches this, because the element IS present and IS the
// right size. Only the reference-vs-definition diff catches it.
//
//   node test/icon-verify.js

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
let pass = 0;
let fail = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label}`);
    if (detail) console.log(`        ${detail}`);
    fail += 1;
  }
}

console.log('');
console.log('Vanish icon set verification');
console.log('============================');

const css = fs.readFileSync(path.join(root, 'assets', 'icons.css'), 'utf8');

// Structural classes, not glyphs.
const NON_GLYPH = new Set(['fa-solid', 'fa-brands', 'fa-regular', 'fa-spin', 'fa-fw']);

const defined = new Set();
for (const match of css.matchAll(/^\.(fa-[a-z0-9-]+)\s*\{/gm)) {
  if (!NON_GLYPH.has(match[1])) defined.add(match[1]);
}
assert(defined.size > 10, `the icon set defines glyphs (${defined.size} found)`);

const sources = ['index.html', 'renderer.js', 'splash.html'].filter((f) =>
  fs.existsSync(path.join(root, f))
);

const referenced = new Map();
for (const file of sources) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/\bfa-[a-z0-9-]+/g)) {
    const name = match[0];
    if (NON_GLYPH.has(name)) continue;
    if (!referenced.has(name)) referenced.set(name, new Set());
    referenced.get(name).add(file);
  }
}

console.log(`  (${referenced.size} icon(s) referenced across ${sources.join(', ')})`);

const missing = [...referenced.keys()].filter((name) => !defined.has(name));
assert(
  missing.length === 0,
  'every icon the UI references is defined and will paint',
  missing.map((m) => `${m} (used in ${[...referenced.get(m)].join(', ')})`).join('\n        ')
);

// A definition nobody uses is dead weight rather than a defect, so this reports
// without failing - deleting one is a judgement call about future use.
const unused = [...defined].filter((name) => !referenced.has(name));
if (unused.length) console.log(`  (note: ${unused.length} defined but unused: ${unused.join(', ')})`);

// Each glyph must actually carry an image, or it is a blank square with a rule
// attached - the same defect wearing a definition.
const empty = [...defined].filter((name) => {
  const rule = new RegExp(`^\\.${name}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return !rule || !/--vi:\s*url\(/.test(rule[1]) || !/svg/i.test(rule[1]);
});
assert(empty.length === 0, 'every defined icon carries an SVG image', empty.join(', '));

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
