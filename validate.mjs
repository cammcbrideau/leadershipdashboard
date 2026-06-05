import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync('worker.js', 'utf8');

// Extract the HTML_SHELL template literal (from `const HTML_SHELL = \`` to the closing `\`;` at EOF area)
const startMarker = 'const HTML_SHELL = `';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) { console.error('HTML_SHELL not found'); process.exit(2); }
const bodyStart = startIdx + startMarker.length;
// The template ends at the final "`;" of the file
const endIdx = src.lastIndexOf('`;');
const templateBody = src.slice(bodyStart, endIdx);

// Evaluate the template literal exactly like JS would, with PROJECT_GID defined
const PROJECT_GID = '1111174651444074';
let html;
try {
  html = vm.runInNewContext('`' + templateBody + '`', { PROJECT_GID });
} catch (e) {
  console.error('TEMPLATE LITERAL EVAL FAILED:', e.message);
  process.exit(2);
}

// Extract inline <script> blocks (no src)
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('Inline script blocks:', scripts.length);

let failed = false;
scripts.forEach((js, i) => {
  try {
    new vm.Script(js); // parses without executing
    console.log(`  block ${i}: OK (${js.length} chars)`);
  } catch (e) {
    failed = true;
    console.error(`  block ${i}: SYNTAX ERROR -> ${e.message}`);
    // Show the offending area
    const m = /:(\d+)/.exec(e.stack || '');
  }
});
process.exit(failed ? 1 : 0);
