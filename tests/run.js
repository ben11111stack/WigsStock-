/* Zero-dependency test runner for WigsStock's pure logic.
 * Run: node tests/run.js   (also wired into CI on every push)
 *
 * app.js has no build step and only touches the DOM inside init(), which is
 * guarded by `typeof document`. It exports its pure functions for Node, so we
 * can exercise the reconciliation / parsing / export logic headless. */
'use strict';

const app = require('../app.js');
const { normBarcode, parseCSV, detectColumns, importInventory, reconcile, toCSV, buildXlsx, state } = app;

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`✗ ${msg}\n    expected: ${e}\n    actual:   ${a}`); }
}
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error(`✗ ${msg}`); } }

// reset the shared state object between inventory-loading tests
function resetState() {
  state.inventory = {}; state.scans = {}; state.cloudScans = {};
  state.cloudUrl = ''; state.countId = ''; state.dirty = {};
}

/* ---------- normBarcode ---------- */
eq(normBarcode('01234'), '1234', 'strips leading zeros on numeric codes');
eq(normBarcode('  1234 '), '1234', 'trims whitespace');
eq(normBarcode('12 34'), '1234', 'removes inner whitespace');
eq(normBarcode("'01234"), '1234', "strips Sheets' leading apostrophe");
eq(normBarcode('0'), '0', 'a lone zero survives');
eq(normBarcode('00700'), '700', 'multiple leading zeros collapse');
eq(normBarcode('ABC12'), 'ABC12', 'alphanumeric codes are left intact');
eq(normBarcode(''), '', 'empty stays empty');
eq(normBarcode(null), '', 'null becomes empty');
// the whole point: sheet side and scan side normalize identically
ok(normBarcode('01234') === normBarcode(' 1234'), 'sheet "01234" and scan " 1234" reconcile as one');

/* ---------- parseCSV ---------- */
eq(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']], 'basic CSV');
eq(parseCSV('a,"b,c",d'), [['a', 'b,c', 'd']], 'quoted comma');
eq(parseCSV('a,"he said ""hi"""'), [['a', 'he said "hi"']], 'escaped quotes');
eq(parseCSV('a,b\r\n1,2'), [['a', 'b'], ['1', '2']], 'CRLF line endings');
eq(parseCSV('﻿a,b'), [['a', 'b']], 'BOM stripped');

/* ---------- detectColumns ---------- */
(() => {
  const m = detectColumns([['barcode', 'status'], ['123', 'in-stock']]);
  eq(m.barcodeCol, 0, 'detects barcode column by header');
  eq(m.statusCol, 1, 'detects status column by header');
  ok(m.hasHeader, 'recognizes a header row');
})();
(() => {
  const m = detectColumns([['ברקוד', 'סטטוס'], ['123', 'in-stock']]);
  eq(m.barcodeCol, 0, 'detects Hebrew barcode header');
  eq(m.statusCol, 1, 'detects Hebrew status header');
})();

/* ---------- importInventory + reconcile ---------- */
(() => {
  resetState();
  importInventory('barcode,status\n01001,in-stock\n01002,in-stock\n01003,sold\n01004,consignment');
  // scan 01001 (ok), 1003 (in store but sold), 09999 (unknown), and 1001 again (dup)
  // note: scans come pre-normalized in the app; mirror that here
  state.scans = {
    '1001': { count: 2, first: 1 },   // ok + duplicate
    '1003': { count: 1, first: 2 },   // found but flagged sold
    '9999': { count: 1, first: 3 },   // unknown barcode
  };
  const r = reconcile();
  eq(r.ok.map(x => x.barcode), ['1001'], 'ok = in-store status and scanned');
  eq(r.foundOther.map(x => x.barcode), ['1003'], 'foundOther = scanned but not in-store status');
  eq(r.unknown.map(x => x.barcode), ['9999'], 'unknown = scanned, not in sheet');
  eq(r.missing.map(x => x.barcode), ['1002', '1004'], 'missing = in-store status, not scanned');
  eq(r.duplicates.map(x => x.barcode), ['1001'], 'duplicates = scanned more than once');
  eq(r.expectedInStock, 3, 'expectedInStock counts in-stock + consignment');
})();

// normalization must make "01001" in the sheet reconcile with a "1001" scan
(() => {
  resetState();
  importInventory('barcode,status\n01001,in-stock');
  ok('1001' in state.inventory, 'sheet barcode 01001 is stored normalized as 1001');
  state.scans = { '1001': { count: 1, first: 1 } };
  const r = reconcile();
  eq(r.ok.length, 1, 'a 1001 scan matches the 01001 sheet row (no false missing/unknown)');
  eq(r.missing.length, 0, 'nothing falsely reported missing');
  eq(r.unknown.length, 0, 'nothing falsely reported unknown');
})();

/* ---------- toCSV ---------- */
eq(toCSV([['a', 'b'], ['1', '2']]), 'a,b\r\n1,2', 'toCSV joins rows with CRLF');
eq(toCSV([['x,y']]), '"x,y"', 'toCSV quotes fields with commas');
eq(toCSV([['he "q"']]), '"he ""q"""', 'toCSV escapes quotes');

/* ---------- buildXlsx ---------- */
(() => {
  const bytes = buildXlsx([{ name: 'Sheet1', rows: [['ברקוד', 'כמות'], ['1234', 5]] }]);
  ok(bytes instanceof Uint8Array && bytes.length > 100, 'buildXlsx returns bytes');
  // valid ZIP starts with the local-file-header magic "PK\x03\x04"
  ok(bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04, 'output is a ZIP (PK header)');
  // and ends with the end-of-central-directory magic "PK\x05\x06"
  const tail = bytes.slice(-22);
  ok(tail[0] === 0x50 && tail[1] === 0x4B && tail[2] === 0x05 && tail[3] === 0x06, 'ZIP has end-of-central-directory');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
