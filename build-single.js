/* Bundles index.html + styles.css + scanning engines + app.js into one
 * self-contained wigsstock-app.html (easy to send / open anywhere).
 * The zxing-cpp WASM binary is inlined as base64 (window.__ZXING_WASM_B64)
 * so the single file scans without fetching anything.
 * Run: node build-single.js
 */
const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');
const zxingWasmJs = fs.readFileSync('zxing-wasm.min.js', 'utf8');
const wasmB64 = fs.readFileSync('zxing_reader.wasm').toString('base64');
const zxing = fs.readFileSync('zxing.min.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');

/* Replacement callbacks, NOT replacement strings: with a string, `$$`/`$&`
 * in the injected code are treated as escape sequences (app.js's `const $$`
 * silently became `const $` and broke the whole single-file build). */
html = html
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + css + '\n</style>')
  .replace('<script src="zxing-wasm.min.js"></script>',
    () => '<script>window.__ZXING_WASM_B64 = "' + wasmB64 + '";</script>\n<script>\n' + zxingWasmJs + '\n</script>')
  .replace('<script src="zxing.min.js"></script>', () => '<script>\n' + zxing + '\n</script>')
  .replace('<script src="app.js"></script>', () => '<script>\n' + app + '\n</script>');

fs.writeFileSync('wigsstock-app.html', html);
console.log('Wrote wigsstock-app.html (' + Math.round(html.length / 1024) + ' KB)');
