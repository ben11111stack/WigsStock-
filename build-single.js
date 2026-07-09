/* Bundles index.html + styles.css + zxing.min.js + app.js into one
 * self-contained wigsstock-app.html (easy to send / open anywhere).
 * Run: node build-single.js
 */
const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');
const zxing = fs.readFileSync('zxing.min.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');

html = html
  .replace('<link rel="stylesheet" href="styles.css">', '<style>\n' + css + '\n</style>')
  .replace('<script src="zxing.min.js"></script>', '<script>\n' + zxing + '\n</script>')
  .replace('<script src="app.js"></script>', '<script>\n' + app + '\n</script>');

fs.writeFileSync('wigsstock-app.html', html);
console.log('Wrote wigsstock-app.html (' + Math.round(html.length / 1024) + ' KB)');
