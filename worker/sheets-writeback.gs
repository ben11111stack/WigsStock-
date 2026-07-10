/**
 * WigsStock – write scan results back into the inventory sheet.
 *
 * STANDALONE script (targets the sheet by SHEET_ID), so it can be deployed
 * from any Google account that has EDIT access to the sheet.
 *
 * SETUP (once, from an account with EDIT access):
 *   1. https://script.google.com → New project.
 *   2. Paste this whole file, Save.
 *   3. Deploy → New deployment → "Web app":
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Deploy, authorize, COPY the Web app URL (ends with /exec).
 *   4. WigsStock app → מלאי → "כתיבה לשיטס", paste that URL.
 *      Once set, the results are written automatically (~every 2 min).
 *
 * Columns it maintains (adds them if missing; never touches your original
 * barcode/status columns):
 *   - "נסרק" (count), "תאריך סריקה" (last scan time), "עמדה" (stations)
 *   - "שם" (wig name) — written from names typed in the app; if your sheet
 *     already has a name column it updates that one. Only non-empty names are
 *     written, so existing names are never blanked.
 *   - "סטטוס (עודכן)" — a status changed from a wig card in the app. Written to
 *     a SEPARATE column so your original status column stays intact.
 *
 * Adding another column later is a one-liner: pick the value out of
 * fields[bc] and push it like the name/status blocks below.
 */

var SHEET_ID = '17Sem_IwgporhMsXEhVvW7ysIamzc_Ktxv-7molhp35k';
var BARCODE_HINTS = ['barcode', 'ברקוד', 'קוד', 'code', 'מספר', 'number', 'sku', 'id', 'פאה', 'wig'];
var NAME_HINTS = ['שם', 'name', 'דגם', 'model', 'תיאור', 'description', 'כותרת', 'title'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var scans = body.scans || {};    // { barcode: { count, last(ms), station } }
    var fields = body.fields || {};  // { barcode: { name, status } }  (editable per-wig fields)

    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
    var values = sheet.getDataRange().getValues();
    if (!values.length) return json({ ok: false, error: 'empty sheet' });

    var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var barcodeCol = indexOfHint(header, BARCODE_HINTS);
    if (barcodeCol === -1) barcodeCol = 0;

    var colScanned = ensureCol(sheet, header, 'נסרק');
    var colDate = ensureCol(sheet, header, 'תאריך סריקה');
    var colStation = ensureCol(sheet, header, 'עמדה');
    // Name goes to the sheet's existing name column if it has one, else a new "שם".
    var haveFields = Object.keys(fields).length > 0;
    var colName = indexOfHint(header, NAME_HINTS);
    if (colName === -1 && haveFields) colName = ensureCol(sheet, header, 'שם');
    var colStatus = haveFields ? ensureCol(sheet, header, 'סטטוס (עודכן)') : -1;
    var tz = Session.getScriptTimeZone() || 'Asia/Jerusalem';

    var oScan = [], oDate = [], oStation = [], oName = [], oStatus = [], written = 0, namesWritten = 0;
    for (var r = 1; r < values.length; r++) {
      var bc = String(values[r][barcodeCol]).trim();
      var s = bc ? scans[bc] : null;
      if (s && s.count) {
        oScan.push([s.count]);
        oDate.push([s.last ? Utilities.formatDate(new Date(s.last), tz, 'dd/MM/yyyy HH:mm') : '']);
        oStation.push([s.station || '']);
        written++;
      } else {
        oScan.push([bc ? 0 : '']); oDate.push(['']); oStation.push(['']);
      }
      // editable fields — preserve the cell's current value when the app has none
      var f = bc ? fields[bc] : null;
      if (colName >= 0) {
        var curName = String(values[r][colName] || '').trim();
        var nm = f && f.name ? String(f.name) : curName;
        if (f && f.name && f.name !== curName) namesWritten++;
        oName.push([nm]);
      }
      if (colStatus >= 0) oStatus.push([f && f.status ? String(f.status) : '']);
    }
    var n = oScan.length;
    if (n) {
      sheet.getRange(2, colScanned + 1, n, 1).setValues(oScan);
      sheet.getRange(2, colDate + 1, n, 1).setValues(oDate);
      sheet.getRange(2, colStation + 1, n, 1).setValues(oStation);
      if (colName >= 0) sheet.getRange(2, colName + 1, n, 1).setValues(oName);
      if (colStatus >= 0) sheet.getRange(2, colStatus + 1, n, 1).setValues(oStatus);
    }
    return json({ ok: true, rows: n, written: written, names: namesWritten });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet() { return json({ ok: true, service: 'wigsstock-writeback' }); }

function ensureCol(sheet, header, name) {
  var i = header.indexOf(name.toLowerCase());
  if (i === -1) { i = header.length; sheet.getRange(1, i + 1).setValue(name); header.push(name.toLowerCase()); }
  return i;
}
function indexOfHint(header, hints) {
  for (var i = 0; i < header.length; i++)
    for (var j = 0; j < hints.length; j++)
      if (header[i].indexOf(hints[j]) !== -1) return i;
  return -1;
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
