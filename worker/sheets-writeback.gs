/**
 * WigsStock – write scan results back into the inventory sheet.
 *
 * SETUP (done once by someone with EDIT access to the sheet):
 *   1. Open the Google Sheet → Extensions → Apps Script.
 *   2. Paste this whole file, Save.
 *   3. Deploy → New deployment → type "Web app":
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Deploy, authorize, and COPY the Web app URL.
 *   4. In the WigsStock app → מלאי → "כתיבה לשיטס", paste that URL.
 *
 * It ONLY adds/updates a single "נסרק" column (scan count per barcode).
 * It never changes your original barcode/status columns.
 */

var RESULT_COLUMN = 'נסרק';   // the one column we add/update

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var scans = body.scans || {};                 // { barcode: count }
    var colName = body.column || RESULT_COLUMN;

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var range = sheet.getDataRange();
    var values = range.getValues();
    if (!values.length) return json({ ok: false, error: 'empty sheet' });

    var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var hints = ['barcode', 'ברקוד', 'קוד', 'code', 'מספר', 'number', 'sku', 'id', 'פאה', 'wig'];
    var barcodeCol = indexOfHint(header, hints);
    if (barcodeCol === -1) barcodeCol = 0;                 // default: column A

    // find or append the result column (never overwrites an existing data column)
    var resultCol = header.indexOf(colName.toLowerCase());
    if (resultCol === -1) {
      resultCol = header.length;
      sheet.getRange(1, resultCol + 1).setValue(colName);
    }

    var out = [];
    var written = 0;
    for (var r = 1; r < values.length; r++) {
      var barcode = String(values[r][barcodeCol]).trim();
      if (!barcode) { out.push(['']); continue; }
      var count = Object.prototype.hasOwnProperty.call(scans, barcode) ? scans[barcode] : 0;
      out.push([count]);
      if (count) written++;
    }
    if (out.length) sheet.getRange(2, resultCol + 1, out.length, 1).setValues(out);

    return json({ ok: true, rows: out.length, written: written, column: colName });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() { return json({ ok: true, service: 'wigsstock-writeback' }); }

function indexOfHint(header, hints) {
  for (var i = 0; i < header.length; i++) {
    for (var j = 0; j < hints.length; j++) {
      if (header[i].indexOf(hints[j]) !== -1) return i;
    }
  }
  return -1;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
