/* =====================================================================
 * WigsStock – Inventory Barcode Scanner
 * ---------------------------------------------------------------------
 * Reconciles physically-scanned wigs against a Google-Sheets export.
 * No build step, no dependencies. Works offline once the page is loaded.
 * Camera scanning uses the native BarcodeDetector API when available;
 * a hardware "keyboard-wedge" scanner works everywhere via the input.
 * ===================================================================== */

'use strict';

/* ---------- Status model ---------- */
// Statuses that mean "should physically be in the store" (treated as in-stock).
const IN_STOCK = 'in-stock';
const IN_STORE_STATUSES = ['in-stock', 'consignment'];
function isInStore(status) { return IN_STORE_STATUSES.includes(status); }
const KNOWN_STATUSES = [
  'barter', 'consignment', 'fix-return', 'in-stock', 'inventory-reserved',
  'missing', 'other', 'personal-use', 'returned', 'sold', 'wish-list'
];

// Deployed cloud backend — used by default so the app syncs out of the box.
const DEFAULT_CLOUD_URL = 'https://wigsstock-sync.benzi-naor.workers.dev';
const DEFAULT_COUNT_ID = 'main';

const APP_VERSION = '1.5.0';
const CHANGELOG = [
  { v: '1.5.0', notes: ['הגדרות ודוחות מסודרים באקורדיונים (מתקפלים)', 'שם הספירה הוסתר (בהגדרות מתקדמות)'] },
  { v: '1.4.1', notes: ['תיקון כפתור הפלאש — מוצג כשהמצלמה פועלת ומנסה להדליק בכל מכשיר שתומך'] },
  { v: '1.4.0', notes: ['לוגו ומיתוג WigsStock', 'כפתור פלאש (פנס) למצלמה', 'שדה הקלדה גלוי תמיד + כפתור "רשום" בשורה', 'התראת עדכון כשיש גרסה חדשה', 'רשימת גרסאות בהגדרות'] },
  { v: '1.3.0', notes: ['טאב הגדרות מרוכז', 'שם עמדה חובה לפני סריקה', 'הדוח מציג מי סרק כל פאה', 'מחיקה/תיקון סריקה שגויה', 'סנכרון מהיר (~4ש\') בין עמדות'] },
  { v: '1.2.0', notes: ['כתיבה אוטומטית לשיטס — נסרק/תאריך/עמדה', 'טעינת מלאי מקישור גוגל שיטס', 'סנכרון מלאי אוטומטי לכל העמדות'] },
  { v: '1.1.0', notes: ['סנכרון ענן בין עמדות', 'דוח מפורט + פילוח לפי סטטוס', 'התקנה כאפליקציה (PWA)'] },
  { v: '1.0.0', notes: ['ספירת מלאי עם סריקת ברקוד', 'התאמה מול גוגל שיטס', 'ייצוא CSV'] }
];

/* ---------- App state (persisted to localStorage) ---------- */
const state = {
  session: '',       // this station's name (device)
  inventory: {},     // barcode -> status   (from the sheet)
  scans: {},         // barcode -> { count, first }  (this device's scans)
  cloudUrl: '',      // Cloudflare Worker base URL ('' = local only)
  countId: '',       // shared inventory-count id across stations
  cloudScans: {},    // barcode -> total  (merged from all devices, pulled from cloud)
  cloudDetail: {},   // barcode -> { count, last, station }  (who scanned, from cloud)
  dirty: {},         // barcode -> true   (scanned locally, not yet synced)
  deviceId: '',      // stable fallback id if no station name is set
  sheetUrl: '',      // Google Sheets link the inventory is loaded/synced from
  writeUrl: '',      // Apps Script web-app URL for writing results back
  lastResetSeen: 0   // cloud reset generation this device has applied
};

const LS_KEY = 'wigsstock_v1';

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (e) {}
}

/* ---------- Small DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

/* =====================================================================
 * CSV parsing (handles quotes, commas, CRLF)
 * ===================================================================== */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  text = text.replace(/^﻿/, ''); // strip BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

/* Try to figure out which columns hold the barcode and the status. */
function detectColumns(rows) {
  if (!rows.length) return null;
  const header = rows[0].map(h => h.trim().toLowerCase());
  const barcodeHints = ['barcode', 'ברקוד', 'קוד', 'code', 'מספר', 'number', 'sku', 'id', 'פאה', 'wig'];
  const statusHints = ['status', 'סטטוס', 'מצב', 'state'];

  let barcodeCol = header.findIndex(h => barcodeHints.some(x => h.includes(x)));
  let statusCol = header.findIndex(h => statusHints.some(x => h.includes(x)));

  // If a real header wasn't found, treat everything as data with default columns.
  const looksLikeHeader = barcodeCol !== -1 || statusCol !== -1 ||
    header.some(h => isNaN(Number(h)) && h !== '');

  if (barcodeCol === -1) barcodeCol = 0;
  if (statusCol === -1) statusCol = 1;

  return { barcodeCol, statusCol, hasHeader: looksLikeHeader };
}

function importInventory(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { added: 0, error: 'הקובץ ריק' };
  const map = detectColumns(rows);
  const dataRows = map.hasHeader ? rows.slice(1) : rows;

  const inv = {};
  let added = 0, unknownStatus = 0;
  for (const r of dataRows) {
    const barcode = (r[map.barcodeCol] || '').trim();
    let status = (r[map.statusCol] || '').trim().toLowerCase();
    if (!barcode) continue;
    if (!KNOWN_STATUSES.includes(status)) {
      // keep it but flag – unknown/blank statuses are treated as "other"
      if (status) unknownStatus++;
      status = status || 'other';
    }
    inv[barcode] = status;
    added++;
  }
  state.inventory = inv;
  save();
  return { added, unknownStatus, barcodeCol: map.barcodeCol, statusCol: map.statusCol, header: map.hasHeader ? rows[0] : null };
}

/* =====================================================================
 * Reconciliation
 * ===================================================================== */
/* Scans used for the report/stats: this device merged with the cloud total
 * (max per barcode, so nothing double-counts and other stations show up). */
function effectiveScans() {
  if (!cloudEnabled() || !state.cloudScans) return state.scans;
  const out = {};
  const keys = new Set([...Object.keys(state.scans), ...Object.keys(state.cloudScans)]);
  for (const k of keys) {
    const local = state.scans[k] ? state.scans[k].count : 0;
    const cloud = state.cloudScans[k] || 0;
    out[k] = { count: Math.max(local, cloud), first: state.scans[k] ? state.scans[k].first : 0 };
  }
  return out;
}

function reconcile() {
  const inv = state.inventory, scans = effectiveScans();
  const invKeys = Object.keys(inv);
  const scanKeys = Object.keys(scans);

  const ok = [];         // in-stock + scanned  -> תקין
  const missing = [];    // in-stock + NOT scanned -> חסר
  const foundOther = []; // scanned + status != in-stock -> נמצא אך מסומן אחרת
  const unknown = [];    // scanned + not in sheet
  const duplicates = []; // scanned > 1

  for (const bc of scanKeys) {
    const s = scans[bc];
    if (s.count > 1) duplicates.push({ barcode: bc, count: s.count });
    if (!(bc in inv)) { unknown.push({ barcode: bc, count: s.count }); continue; }
    if (isInStore(inv[bc])) ok.push({ barcode: bc, status: inv[bc] });
    else foundOther.push({ barcode: bc, status: inv[bc] });
  }

  for (const bc of invKeys) {
    if (isInStore(inv[bc]) && !(bc in scans)) missing.push({ barcode: bc, status: inv[bc] });
  }

  const sortBc = (a, b) => a.barcode.localeCompare(b.barcode, undefined, { numeric: true });
  [ok, missing, foundOther, unknown, duplicates].forEach(a => a.sort(sortBc));

  return {
    ok, missing, foundOther, unknown, duplicates,
    totalScanned: scanKeys.length,
    totalInventory: invKeys.length,
    expectedInStock: invKeys.filter(bc => isInStore(inv[bc])).length
  };
}

/* =====================================================================
 * Scanning
 * ===================================================================== */
let lastScanTs = 0;
let lastScanCode = '';

function recordScan(rawCode) {
  const code = String(rawCode).trim();
  if (!code) return;
  if (!hasStation()) { applyStationGate(); return; }   // never record without a station

  // Debounce: ignore the same code fired twice within 1.2s (camera repeats).
  const now = Date.now();
  if (code === lastScanCode && now - lastScanTs < 1200) return;
  lastScanCode = code; lastScanTs = now;

  const existing = state.scans[code];
  if (existing) existing.count++;
  else state.scans[code] = { count: 1, first: now };
  if (cloudEnabled()) { state.dirty[code] = true; schedulePush(); }
  save();

  showScanFeedback(code, !!existing);
  renderReport();
  renderScanStats();
}

// Worker-facing feedback is deliberately status-agnostic: a scanned wig just
// shows "scanned successfully". The sheet status (sold/consignment/…) is only
// surfaced to the manager in the report, not to the scanning worker.
function showScanFeedback(code, wasDuplicate) {
  const banner = $('#scanBanner');
  const known = code in state.inventory;
  let kind, msg;
  if (!known) { kind = 'unknown'; msg = '❓ ברקוד לא מוכר — לא בקובץ'; }
  else if (wasDuplicate) { kind = 'dup'; msg = '🔁 כבר נסרק'; }
  else { kind = 'ok'; msg = '✅ נסרק בהצלחה'; }
  banner.className = 'scan-banner ' + kind;
  banner.innerHTML = `<div class="code">${esc(code)}</div><div class="msg">${msg}</div>`;
  // flash the scan line green on a successful read (red otherwise)
  const frame = document.querySelector('.scan-frame');
  if (frame && (kind === 'ok' || kind === 'dup')) {
    frame.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => frame.classList.remove('hit'), 700);
  }
  beep(kind);
  if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 40 : [40, 60, 40]);
}
let hitTimer = null;

/* Web-Audio beep so workers get audible confirmation without a sound file. */
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    const freq = kind === 'ok' ? 880 : kind === 'dup' ? 620 : 320;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .18);
    osc.start(); osc.stop(audioCtx.currentTime + .18);
  } catch (e) {}
}

/* ---------- Hardware / manual input ---------- */
function setupScanInput() {
  const input = $('#scanInput');
  const commit = () => {
    const v = input.value.trim();
    if (v) recordScan(v);
    input.value = '';
    input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  $('#manualAdd').addEventListener('click', commit);
}

/* ---------- Camera scanning ----------
 * Uses ZXing on every platform (consistent, and the native BarcodeDetector
 * proved unreliable on some Android builds). TRY_HARDER + an explicit 1D
 * format list are what actually decode real-world barcodes.
 * Camera access requires a secure context (https:// or localhost) — opening
 * the file directly from disk on a phone will NOT get the camera; host it
 * (e.g. GitHub Pages) for camera scanning. Hardware scanners work anywhere.
 */
let cameraOn = false, zxingReader = null, cameraStream = null, scanTimer = null, scanCanvas = null, scanCtx = null;

function showCamStart(msg) {
  const s = $('#camStart'); if (s) s.classList.remove('hidden');
  if (msg !== undefined) $('#cameraNote').textContent = msg;
}

function setBannerLive() {
  const b = $('#scanBanner');
  if (b) { b.className = 'scan-banner'; b.innerHTML = '<div class="msg muted">📷 מצלמה פעילה — כוונו ברקוד למסגרת</div>'; }
}

function makeReader() {
  const hints = new Map();
  const F = ZXing.BarcodeFormat;
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
    [F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.QR_CODE]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);   // critical for real barcodes
  return new ZXing.BrowserMultiFormatReader(hints, 100);
}

async function startCamera() {
  const btn = $('#cameraBtn');
  if (cameraOn) { stopCamera(); return; }

  if (!isSecureContextForCamera()) {
    showCamStart('למצלמה צריך כתובת מאובטחת (https) — פתחי מהלינק, לא מקובץ מקומי. בינתיים: סורק חיצוני או הקלדה.');
    return;
  }
  if (!window.ZXing || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamStart('הדפדפן לא תומך בגישה למצלמה. השתמשי בסורק חיצוני או בהקלדה.');
    return;
  }

  const video = $('#video');
  $('#reader').classList.remove('hidden');
  $('#camStart').classList.add('hidden');
  $('#cameraNote').textContent = '';
  btn.textContent = '⏹';
  cameraOn = true;
  setBannerLive();   // show immediately so it never looks stuck on "opening…"

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    video.srcObject = cameraStream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    zxingReader = makeReader();
    scanCanvas = document.createElement('canvas');
    scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    scanTick();   // our own decode loop — guarantees frames are actually decoded
    updateFlashButton();
  } catch (e) {
    cameraOn = false;
    btn.textContent = '📷';
    const denied = /denied|permission|NotAllowed/i.test(e.name + ' ' + (e.message || ''));
    showCamStart(denied ? 'הקש/י על הכפתור כדי לאשר מצלמה 📷' : 'לא ניתן לגשת למצלמה: ' + (e.message || e));
  }
}

/* Grab the current video frame and try to decode it. TRY_HARDER handles
 * rotation/imperfect framing. Decoding the full frame (capped width) each
 * ~90ms is reliable across devices. */
function scanTick() {
  if (!cameraOn) return;
  const video = $('#video');
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (video.readyState >= 2 && vw && vh) {
      const scale = Math.min(1, 1280 / vw);
      const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
      if (scanCanvas.width !== cw) { scanCanvas.width = cw; scanCanvas.height = ch; }
      scanCtx.drawImage(video, 0, 0, cw, ch);
      const src = new ZXing.HTMLCanvasElementLuminanceSource(scanCanvas);
      const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
      try {
        const res = zxingReader.decodeBitmap(bmp);
        if (res) recordScan(res.getText());
      } catch (e) { /* NotFoundException — no barcode this frame */ }
    }
  } catch (e) { /* frame not ready */ }
  scanTimer = setTimeout(scanTick, 90);
}

function isSecureContextForCamera() {
  return window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
}

function stopCamera() {
  cameraOn = false;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (e) {} zxingReader = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const v = $('#video'); if (v) { try { v.srcObject = null; } catch (e) {} }
  $('#cameraBtn').textContent = '📷';
  const s = $('#camStart'); if (s) s.classList.remove('hidden');
  torchOn = false;
  const fb = $('#flashBtn'); if (fb) { fb.classList.add('hidden'); fb.classList.remove('active'); }
}

// Camera flash / torch. Don't pre-judge support via getCapabilities (flaky
// and hid the button on Android where it works) — just show it while the
// camera is on and try to toggle on tap; only hide if the device rejects it.
let torchOn = false;
function torchTrack() { return cameraStream && cameraStream.getVideoTracks ? cameraStream.getVideoTracks()[0] : null; }
function updateFlashButton() {
  const btn = $('#flashBtn'); if (!btn) return;
  if (cameraOn) btn.classList.remove('hidden');
  else { btn.classList.add('hidden'); btn.classList.remove('active'); torchOn = false; }
}
async function toggleTorch() {
  const track = torchTrack(); if (!track) return;
  const btn = $('#flashBtn'), note = $('#cameraNote');
  try {
    torchOn = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: torchOn }] });
    btn.classList.toggle('active', torchOn);
    if (note) note.textContent = '';
  } catch (e) {
    torchOn = false; btn.classList.remove('active');
    if (note) note.textContent = 'הפלאש לא נתמך במצלמה/דפדפן הזה';
  }
}

/* =====================================================================
 * Rendering
 * ===================================================================== */
function tableFor(list, cols) {
  if (!list.length) return '<p class="muted small">אין פריטים בקטגוריה זו.</p>';
  const head = cols.map(c => `<th>${c.label}</th>`).join('');
  const body = list.slice(0, 500).map(item => {
    return '<tr>' + cols.map(c => `<td>${c.render(item)}</td>`).join('') + '</tr>';
  }).join('');
  const more = list.length > 500 ? `<p class="muted small">מוצגים 500 מתוך ${list.length}. הייצוא כולל את כולם.</p>` : '';
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function renderScanStats() {
  const r = reconcile();
  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  set('#scanCount', r.totalScanned);
  set('#scanOk', r.ok.length);
  set('#scanWarn', r.foundOther.length);
  set('#scanUnknown', r.unknown.length);
}

const CHEV = '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
function accCard(title, badge, desc, body, open) {
  return `<div class="acc${open ? ' open' : ''}">` +
    `<button class="acc-head"><span class="acc-titles"><span class="acc-title">${title}</span>` +
    `${desc ? `<span class="acc-sub">${desc}</span>` : ''}</span>` +
    `<span class="badge">${badge}</span>${CHEV}</button>` +
    `<div class="acc-body">${body}</div></div>`;
}

function statusBreakdownTable() {
  const inv = state.inventory, scans = effectiveScans();
  const totals = {}, scanned = {};
  for (const bc in inv) {
    const st = inv[bc];
    totals[st] = (totals[st] || 0) + 1;
    if (bc in scans) scanned[st] = (scanned[st] || 0) + 1;
  }
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!keys.length) return '<p class="muted small">—</p>';
  const rows = keys.map(st =>
    `<tr><td><span class="tag ${isInStore(st) ? 'instock' : 'other'}">${esc(st)}</span></td>` +
    `<td>${totals[st].toLocaleString()}</td><td>${(scanned[st] || 0).toLocaleString()}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>סטטוס</th><th>סה"כ</th><th>נסרקו</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderReport() {
  const r = reconcile();
  const el = $('#reportBody');
  if (!r.totalInventory) {
    el.innerHTML = '<div class="card"><p class="muted">עדיין לא נטען מלאי. עברי ללשונית "טעינת מלאי".</p></div>';
    return;
  }

  const bcCol = { label: 'ברקוד', render: i => `<b>${esc(i.barcode)}</b>` };
  const statusCol = { label: 'סטטוס בשיטס', render: i =>
    `<span class="tag ${isInStore(i.status) ? 'instock' : 'other'}">${esc(i.status)}</span>` };
  const countCol = { label: 'פעמים', render: i => i.count };
  const stationCol = { label: 'עמדה', render: i => {
    const d = state.cloudDetail && state.cloudDetail[i.barcode];
    return d && d.station ? esc(d.station) : '<span class="muted">—</span>';
  } };
  const delCol = { label: '', render: i =>
    `<button class="del-btn" title="מחק סריקה" onclick='deleteScan(${JSON.stringify(i.barcode)})'>🗑</button>` };
  const expected = r.expectedInStock;
  const pct = expected ? Math.round(r.ok.length / expected * 100) : 0;
  const cloudLine = cloudEnabled()
    ? `<span class="muted small">☁️ ${state.countId} · ${state.cloudDevices || 0} עמדות</span>`
    : `<span class="muted small">מקומי</span>`;

  el.innerHTML = `
    <div class="card">
      <div class="rep-head">
        <h2>דוח ספירה</h2>
        <button class="btn ghost small-btn" onclick="pullCloud();renderReport()">🔄 רענן</button>
      </div>
      ${cloudLine}
      <div class="progress" title="${pct}%"><div class="progress-bar" style="width:${pct}%"></div></div>
      <p class="muted small">נסרקו <b>${r.ok.length.toLocaleString()}</b> מתוך <b>${expected.toLocaleString()}</b> שאמורות להיות בחנות (<b>${pct}%</b>)</p>
      <div class="stats">
        <div class="stat total"><div class="num">${r.totalInventory.toLocaleString()}</div><div class="lbl">סה"כ במלאי (שיטס)</div></div>
        <div class="stat"><div class="num">${r.totalScanned.toLocaleString()}</div><div class="lbl">נסרקו פיזית</div></div>
        <div class="stat ok"><div class="num">${r.ok.length.toLocaleString()}</div><div class="lbl">✅ תקין (במלאי + נסרק)</div></div>
        <div class="stat bad"><div class="num">${r.missing.length.toLocaleString()}</div><div class="lbl">❌ חסר (אמור בחנות, לא נסרק)</div></div>
        <div class="stat warn"><div class="num">${r.foundOther.length.toLocaleString()}</div><div class="lbl">⚠️ בחנות אך מסומן אחרת</div></div>
        <div class="stat unknown"><div class="num">${r.unknown.length.toLocaleString()}</div><div class="lbl">❓ ברקוד לא מוכר</div></div>
      </div>
      <p class="muted small" style="margin-top:10px">צפוי בחנות (in-stock+consignment): <b>${expected.toLocaleString()}</b> · כפילויות: <b>${r.duplicates.length}</b></p>
    </div>

    ${accCard('⚠️ בחנות אך מסומן אחרת', r.foundOther.length,
      'נסרקו פיזית אך לא רשומות כ-in-stock — צריך להחזיר ל-in-stock',
      tableFor(r.foundOther, [bcCol, statusCol, stationCol, delCol]), r.foundOther.length > 0)}

    ${accCard('❌ חסרות', r.missing.length,
      'אמורות בחנות אך לא נסרקו — כנראה נמכרו/אבדו ולא עודכן',
      tableFor(r.missing, [bcCol]))}

    ${accCard('❓ ברקודים לא מוכרים', r.unknown.length,
      'נסרקו אך לא קיימים בקובץ המלאי',
      tableFor(r.unknown, [bcCol, countCol, stationCol, delCol]))}

    ${accCard('🔁 כפילויות', r.duplicates.length, 'נסרקו יותר מפעם אחת',
      tableFor(r.duplicates, [bcCol, countCol]))}

    ${accCard('✅ תקין', r.ok.length, 'במלאי ונסרקו כמו שצריך',
      tableFor(r.ok, [bcCol, stationCol, delCol]))}

    ${accCard('📋 פילוח לפי סטטוס בשיטס', r.totalInventory.toLocaleString(),
      'כמה מכל סטטוס — וכמה נסרקו', statusBreakdownTable())}
  `;
}

function renderInventoryStatus() {
  const n = Object.keys(state.inventory).length;
  const el = $('#invStatus');
  if (!n) { el.innerHTML = '<span class="muted">לא נטען מלאי עדיין.</span>'; return; }
  const counts = {};
  for (const s of Object.values(state.inventory)) counts[s] = (counts[s] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `<tr><td><span class="tag ${isInStore(s) ? 'instock' : 'other'}">${esc(s)}</span></td><td>${c.toLocaleString()}</td></tr>`).join('');
  el.innerHTML = `
    <p>✅ נטענו <b>${n.toLocaleString()}</b> פאות.</p>
    <div class="scroll"><table><thead><tr><th>סטטוס</th><th>כמות</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* =====================================================================
 * Export
 * ===================================================================== */
function toCSV(rows) {
  return rows.map(r => r.map(f => {
    f = f == null ? '' : String(f);
    return /[",\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f;
  }).join(',')).join('\r\n');
}
function download(filename, text) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp() {
  return (state.session ? state.session.replace(/\s+/g, '-') + '_' : '') + 'wigsstock';
}

function exportFull() {
  const r = reconcile();
  const rows = [['barcode', 'category', 'sheet_status', 'scan_count']];
  const push = (list, cat) => list.forEach(i =>
    rows.push([i.barcode, cat, i.status || (state.inventory[i.barcode] || ''), (state.scans[i.barcode]?.count) || (i.count || '')]));
  push(r.foundOther, 'in-store-but-flagged');
  push(r.missing, 'missing');
  push(r.unknown, 'unknown-barcode');
  push(r.ok, 'ok');
  download(stamp() + '_reconciliation.csv', toCSV(rows));
}

function exportUpdates() {
  // Suggested status corrections to paste back into the sheet.
  const r = reconcile();
  const rows = [['barcode', 'current_status', 'suggested_status', 'reason']];
  r.foundOther.forEach(i => rows.push([i.barcode, i.status, IN_STOCK, 'נסרק בחנות']));
  r.missing.forEach(i => rows.push([i.barcode, IN_STOCK, 'missing', 'רשום in-stock אך לא נסרק']));
  download(stamp() + '_status_updates.csv', toCSV(rows));
}

function exportScans() {
  const rows = [['barcode', 'scan_count']];
  Object.entries(state.scans).forEach(([bc, s]) => rows.push([bc, s.count]));
  download(stamp() + '_raw_scans.csv', toCSV(rows));
}

/* Merge another device's raw-scans CSV into this one (for multi-worker counts). */
function mergeScans(text) {
  const rows = parseCSV(text);
  let merged = 0;
  const hasHeader = rows.length && isNaN(Number((rows[0][0] || '').trim()));
  const data = hasHeader ? rows.slice(1) : rows;
  for (const r of data) {
    const bc = (r[0] || '').trim();
    const cnt = parseInt(r[1], 10) || 1;
    if (!bc) continue;
    if (state.scans[bc]) state.scans[bc].count += cnt;
    else state.scans[bc] = { count: cnt, first: Date.now() };
    merged++;
  }
  save();
  renderReport(); renderScanStats();
  return merged;
}

/* =====================================================================
 * Cloud sync (Cloudflare Worker)
 * Local-first: scans always land in localStorage instantly; the cloud is
 * synced in the background with an offline-safe retry. Pushing a device's
 * absolute counts is idempotent, so retries never double-count.
 * ===================================================================== */
function cloudEnabled() { return !!(state.cloudUrl && state.countId); }
function cloudBase() { return state.cloudUrl.replace(/\/+$/, ''); }
function deviceId() { return (state.session && state.session.trim()) || state.deviceId; }

let syncTimer = null, retryTimer = null, syncing = false, pollTimer = null;

function schedulePush() {
  if (!cloudEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushCloud, 700);
}

async function pushCloud() {
  if (!cloudEnabled() || syncing) return;
  const barcodes = Object.keys(state.dirty);
  if (!barcodes.length) return;
  syncing = true;
  setCloudStatus('syncing');
  const scans = {};
  barcodes.forEach(b => { if (state.scans[b]) scans[b] = state.scans[b].count; });
  try {
    const res = await fetch(cloudBase() + '/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count_id: state.countId, device: deviceId(), scans })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    barcodes.forEach(b => delete state.dirty[b]);   // only clear what we sent
    save();
    setCloudStatus('ok');
    pullCloud();
  } catch (e) {
    setCloudStatus('offline');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(pushCloud, 5000);       // keep retrying; scans persist locally
  } finally {
    syncing = false;
    if (Object.keys(state.dirty).length && navigator.onLine) schedulePush();
  }
}

async function pullCloud() {
  if (!cloudEnabled()) return;
  try {
    const res = await fetch(cloudBase() + '/api/scans?count_id=' + encodeURIComponent(state.countId));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // a reset (or a delete correction) elsewhere clears this device's local scans too
    if (data.reset_at && data.reset_at > (state.lastResetSeen || 0)) {
      state.lastResetSeen = data.reset_at;
      state.scans = {}; state.dirty = {};
    }
    state.cloudScans = data.scans || {};
    state.cloudDetail = data.detail || {};
    state.cloudDevices = data.devices || 0;
    save();
    renderReport(); renderScanStats();
    setCloudStatus('ok', data);
    // adopt the shared inventory source set by the manager (loads it on every station)
    if (data.sheet_url && data.sheet_url !== state.sheetUrl) {
      state.sheetUrl = data.sheet_url;
      const el = $('#sheetUrl'); if (el) el.value = state.sheetUrl;
      save();
      loadFromSheet(false);
    }
  } catch (e) { /* keep last known cloud data */ }
}

function markAllDirty() { Object.keys(state.scans).forEach(b => { state.dirty[b] = true; }); }

// Delete/correct a single barcode's scans across the whole count.
async function deleteScan(barcode) {
  barcode = String(barcode);
  if (!confirm('למחוק את הסריקה של ' + barcode + '?\n(מכל העמדות בספירה)')) return;
  delete state.scans[barcode];
  delete state.dirty[barcode];
  if (state.cloudScans) delete state.cloudScans[barcode];
  if (state.cloudDetail) delete state.cloudDetail[barcode];
  save(); renderReport(); renderScanStats();
  if (cloudEnabled()) {
    try {
      const r = await fetch(cloudBase() + '/api/delete-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count_id: state.countId, barcode })
      });
      const j = await r.json().catch(() => ({}));
      if (j.reset_at) { state.lastResetSeen = j.reset_at; save(); }   // don't self-wipe on the resync it triggers
    } catch (e) { alert('נמחק מקומית, אך הענן לא עודכן: ' + e.message); }
  }
}

function startPolling() {
  clearInterval(pollTimer);
  if (!cloudEnabled()) return;
  pollTimer = setInterval(() => {
    if (!cloudEnabled()) return;
    if (Object.keys(state.dirty).length) pushCloud();
    pullCloud();
  }, 4000);   // near-immediate cross-station sync
}

function setCloudStatus(kind, data) {
  const el = $('#cloudStatus');
  if (!el) return;
  if (!cloudEnabled()) { el.innerHTML = '<span class="muted small">מקומי בלבד — לא מוגדר ענן.</span>'; return; }
  const map = {
    ok: ['ok', '✅ מסונכרן'],
    syncing: ['dup', '⏳ מסנכרן…'],
    offline: ['warn', '⚠️ אין חיבור — יסונכרן אוטומטית כשתחזור רשת']
  };
  const [cls, label] = map[kind] || map.ok;
  const extra = (kind === 'ok' && data) ? ` · ${data.barcodes || 0} ברקודים · ${data.devices || 0} עמדות` : '';
  const pend = Object.keys(state.dirty).length;
  const pendTxt = pend ? ` · ${pend} ממתינים` : '';
  el.innerHTML = `<span class="tag ${cls === 'ok' ? 'instock' : 'other'}">${label}</span><span class="muted small">${extra}${pendTxt}</span>`;
}

function applyCloudConfig() {
  save();
  if (cloudEnabled()) {
    markAllDirty();
    setCloudStatus('syncing');
    pushCloud();
    startPolling();
  } else {
    clearInterval(pollTimer);
    setCloudStatus();
  }
}

/* =====================================================================
 * Install to home screen (PWA)
 * Android/Chrome: fires beforeinstallprompt -> we show a real Install button.
 * iOS/Safari: no such API -> we can only show the manual instruction.
 * ===================================================================== */
let deferredPrompt = null;
const INSTALL_DISMISS = 'wigsstock_install_dismissed';

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function showInstallBar(mode) {
  if (isStandalone() || localStorage.getItem(INSTALL_DISMISS)) return;
  const bar = $('#installBar'), btn = $('#installBtn'), txt = $('#installText');
  if (!bar) return;
  if (mode === 'ios') {
    btn.classList.add('hidden');
    txt.innerHTML = 'להתקנה: שיתוף ⬆️ ← "הוסף למסך הבית"';
  } else {
    btn.classList.remove('hidden');
    txt.textContent = 'התקן את האפליקציה למסך הבית 📲';
  }
  bar.classList.remove('hidden');
}
function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBar('android');
  });
  window.addEventListener('appinstalled', () => {
    $('#installBar').classList.add('hidden');
    deferredPrompt = null;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBar').classList.add('hidden');
  });
  $('#installClose').addEventListener('click', () => {
    $('#installBar').classList.add('hidden');
    try { localStorage.setItem(INSTALL_DISMISS, '1'); } catch (e) {}
  });
  // iOS has no install event — show the manual hint on Safari (not already installed)
  if (isIOS() && !isStandalone()) showInstallBar('ios');
}

/* =====================================================================
 * Tabs + wiring
 * ===================================================================== */
function ensureCamera() { if (!cameraOn) startCamera(); }

function hasStation() { return !!(state.session && state.session.trim()); }

function updateStationChip() {
  const chip = $('#stationChip');
  if (!chip) return;
  if (hasStation()) { chip.textContent = '👤 ' + state.session.trim(); chip.classList.remove('warn'); }
  else { chip.textContent = '⚠️ הגדר עמדה'; chip.classList.add('warn'); }
}

// Station is mandatory before scanning — show a gate until it's filled.
function applyStationGate() {
  const gate = $('#stationGate'), scanner = document.querySelector('#panel-scan .scanner');
  const missing = !hasStation();
  if (gate) gate.classList.toggle('hidden', !missing);
  if (scanner) scanner.classList.toggle('hidden', missing);
  return missing;
}

// push a history entry so the hardware/browser back button returns to the
// previous tab instead of closing the installed app
function navigate(name) {
  if (document.querySelector('#panel-' + name + '.active')) return;
  history.pushState({ tab: name }, '');
  showTab(name);
}

function showTab(name) {
  const wasScan = !!document.querySelector('#panel-scan.active');
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'panel-' + name));
  $$('nav button').forEach(b => b.classList.toggle('active', b.id === 'tab-' + name));
  if (wasScan && name !== 'scan') stopCamera();       // free the camera when leaving
  if (name === 'report') { renderReport(); if (cloudEnabled()) pullCloud(); }   // refresh across stations
  if (name === 'scan') {
    // require a station name first; start camera within the tap so iOS allows it
    if (applyStationGate()) { setTimeout(() => $('#stationGateInput').focus(), 60); }
    else ensureCamera();
  }
}

function init() {
  load();

  // session / station name (now lives in Settings; mandatory before scanning)
  const sess = $('#sessionName');
  sess.value = state.session || '';
  sess.addEventListener('input', () => { state.session = sess.value; save(); setCloudStatus(); updateStationChip(); });
  updateStationChip();
  $('#stationChip').addEventListener('click', () => navigate('settings'));

  // mandatory-station gate on the scan tab
  $('#stationGateSave').addEventListener('click', () => {
    const v = $('#stationGateInput').value.trim();
    if (!v) { $('#stationGateInput').focus(); return; }
    state.session = v; sess.value = v; save();
    updateStationChip(); setCloudStatus();
    applyStationGate();
    ensureCamera();
  });

  // stable device id fallback (used if no station name is typed)
  if (!state.deviceId) { state.deviceId = 'dev-' + Math.random().toString(36).slice(2, 8); save(); }

  // default the cloud config to the deployed backend so it works out of the box
  let cloudDefaulted = false;
  if (!state.cloudUrl) { state.cloudUrl = DEFAULT_CLOUD_URL; cloudDefaulted = true; }
  if (!state.countId) { state.countId = DEFAULT_COUNT_ID; cloudDefaulted = true; }
  if (cloudDefaulted) save();

  // cloud sync config
  const cloudUrlEl = $('#cloudUrl'), countIdEl = $('#countId');
  if (cloudUrlEl) {
    cloudUrlEl.value = state.cloudUrl || '';
    countIdEl.value = state.countId || '';
    cloudUrlEl.addEventListener('change', () => { state.cloudUrl = cloudUrlEl.value.trim(); applyCloudConfig(); });
    countIdEl.addEventListener('change', () => { state.countId = countIdEl.value.trim(); applyCloudConfig(); });
    $('#cloudTest').addEventListener('click', async () => {
      if (!state.cloudUrl) { alert('הזיני קודם כתובת שרת'); return; }
      try {
        const r = await fetch(cloudBase() + '/api/health');
        alert(r.ok ? '✅ החיבור תקין' : '⚠️ השרת ענה עם שגיאה ' + r.status);
      } catch (e) { alert('❌ לא הצלחתי להתחבר: ' + e.message); }
    });
    $('#cloudPull').addEventListener('click', () => { if (cloudEnabled()) pullCloud(); else alert('הגדירי כתובת שרת ושם ספירה'); });

    if (cloudEnabled()) {
      if (cloudDefaulted) markAllDirty();   // push any pre-existing local scans up once
      setCloudStatus('syncing');
      startPolling();
      pullCloud();
      if (Object.keys(state.dirty).length) pushCloud();
    } else {
      setCloudStatus();
    }
  }
  // flush the offline queue the moment the network returns
  window.addEventListener('online', () => { if (cloudEnabled() && Object.keys(state.dirty).length) pushCloud(); });

  // tabs (each switch pushes history so the back button walks tabs, not out of the app)
  $$('nav button').forEach(b => b.addEventListener('click', () => navigate(b.id.replace('tab-', ''))));
  window.addEventListener('popstate', (e) => {
    const st = e.state || { tab: 'scan' };
    showTab(st.tab || 'scan');
  });

  // accordions (settings + report) — tap header to expand/collapse
  document.addEventListener('click', (e) => {
    const head = e.target.closest('.acc-head');
    if (head && head.parentElement && head.parentElement.classList.contains('acc')) {
      head.parentElement.classList.toggle('open');
    }
  });

  // inventory load
  $('#invFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handleImport(reader.result);
    reader.readAsText(file, 'UTF-8');
  });
  $('#invPasteBtn').addEventListener('click', () => {
    const t = $('#invPaste').value.trim();
    if (t) handleImport(t);
  });
  $('#loadSample').addEventListener('click', async () => {
    try {
      const r = await fetch('sample-inventory.csv', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      handleImport(await r.text());
    } catch (e) { alert('לא הצלחתי לטעון דוגמה: ' + e.message); }
  });

  // load inventory from a shared Google Sheets link (via the Worker proxy)
  const sheetEl = $('#sheetUrl');
  if (sheetEl) {
    sheetEl.value = state.sheetUrl || '';
    sheetEl.addEventListener('change', () => { state.sheetUrl = sheetEl.value.trim(); save(); });
    $('#sheetLoad').addEventListener('click', () => { state.sheetUrl = sheetEl.value.trim(); save(); loadFromSheet(true); });
    if (state.sheetUrl) loadFromSheet(false);   // refresh inventory from the sheet on open
  }

  // write results back to the sheet (via Apps Script)
  const writeEl = $('#writeUrl');
  if (writeEl) {
    writeEl.value = state.writeUrl || '';
    writeEl.addEventListener('change', () => { state.writeUrl = writeEl.value.trim(); save(); registerScriptUrl(); });
    $('#writeBtn').addEventListener('click', () => { state.writeUrl = writeEl.value.trim(); save(); writeToSheet(); });
  }
  $('#clearInv').addEventListener('click', () => {
    if (confirm('למחוק את המלאי שנטען?')) { state.inventory = {}; save(); renderInventoryStatus(); renderReport(); }
  });

  // install to home screen
  setupInstall();

  // scanning
  setupScanInput();
  $('#cameraBtn').addEventListener('click', startCamera);
  $('#camStart').addEventListener('click', startCamera);   // tap-to-start (required on iOS)
  $('#flashBtn').addEventListener('click', toggleTorch);

  // reset scans
  $('#resetScans').addEventListener('click', async () => {
    if (!confirm('לאפס את כל הסריקות של הספירה הזו?\n(כולל בענן — לכל העמדות. המלאי יישאר)')) return;
    state.scans = {}; state.dirty = {}; state.cloudScans = {}; save();
    if (cloudEnabled()) {
      try {
        const rr = await fetch(cloudBase() + '/api/reset', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count_id: state.countId })
        });
        const rj = await rr.json().catch(() => ({}));
        if (rj.reset_at) { state.lastResetSeen = rj.reset_at; save(); }   // don't re-trigger on our own reset
      } catch (e) { alert('אופס מקומי בוצע, אך לא הצלחתי לאפס בענן: ' + e.message); }
    }
    renderReport(); renderScanStats();
    $('#scanBanner').className = 'scan-banner';
    $('#scanBanner').innerHTML = '<div class="msg muted">מוכן לסריקה…</div>';
  });

  // export
  $('#expFull').addEventListener('click', exportFull);
  $('#expUpdates').addEventListener('click', exportUpdates);
  $('#expScans').addEventListener('click', exportScans);
  $('#mergeFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => alert('מוזגו ' + mergeScans(reader.result) + ' סריקות.');
    reader.readAsText(file, 'UTF-8');
  });

  renderVersions();
  renderInventoryStatus();
  renderScanStats();
  renderReport();

  // scan tab is the default landing view; seed history so back walks tabs
  const start = 'scan';
  history.replaceState({ tab: start }, '');
  showTab(start);
}

function renderVersions() {
  const cur = $('#curVersion'); if (cur) cur.textContent = APP_VERSION;
  const sub = $('#curVersionSub'); if (sub) sub.textContent = 'גרסה ' + APP_VERSION;
  const el = $('#changelog'); if (!el) return;
  el.innerHTML = CHANGELOG.map(c =>
    `<div class="ver"><b>גרסה ${esc(c.v)}</b><ul>${c.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`
  ).join('');
}

function handleImport(text) {
  const res = importInventory(text);
  if (res.error) { alert(res.error); return; }
  renderInventoryStatus();
  renderReport();
  renderScanStats();
  let note = `נטענו ${res.added.toLocaleString()} פאות.`;
  if (res.unknownStatus) note += ` (${res.unknownStatus} עם סטטוס לא מזוהה — סווגו כ-other)`;
  $('#importNote').textContent = note;
}

// Load the inventory from a shared Google Sheet, proxied through the Worker.
async function loadFromSheet(alertOnError) {
  const note = $('#sheetNote');
  const setNote = (color, txt) => { if (note) { note.style.color = color; note.textContent = txt; } };
  if (!state.sheetUrl) { if (alertOnError) alert('הדביקי קישור לגיליון'); return; }
  if (!state.cloudUrl) { setNote('var(--bad)', 'צריך כתובת שרת (ענן) כדי לטעון מקישור.'); return; }
  setNote('var(--ink-3)', 'טוען מהשיטס…');
  try {
    const r = await fetch(cloudBase() + '/api/sheet?url=' + encodeURIComponent(state.sheetUrl), { cache: 'no-store' });
    if (!r.ok) {
      let msg = 'שגיאה ' + r.status;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    const text = await r.text();
    const res = importInventory(text);
    if (res.error) throw new Error(res.error);
    renderInventoryStatus(); renderReport(); renderScanStats();
    setNote('var(--ok)', `✅ נטענו ${res.added.toLocaleString()} פאות מהשיטס`);
    // share this inventory source with the whole count so other stations auto-load it
    if (alertOnError && cloudEnabled()) {
      try {
        await fetch(cloudBase() + '/api/config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count_id: state.countId, sheet_url: state.sheetUrl })
        });
      } catch (e) { /* non-fatal */ }
    }
  } catch (e) {
    setNote('var(--bad)', '❌ ' + e.message);
    if (alertOnError) alert('לא הצלחתי לטעון מהשיטס: ' + e.message);
  }
}

// Register the Apps Script URL for the count so the cron auto-writes.
async function registerScriptUrl() {
  if (!cloudEnabled() || !state.writeUrl) return;
  try {
    await fetch(cloudBase() + '/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count_id: state.countId, script_url: state.writeUrl })
    });
  } catch (e) { /* non-fatal */ }
}

// Write results back to the sheet now. The Worker pulls the authoritative
// scans (all stations) from the cloud, so it never depends on this device.
async function writeToSheet() {
  const note = $('#writeNote');
  const setNote = (c, t) => { if (note) { note.style.color = c; note.textContent = t; } };
  if (!state.writeUrl) { setNote('var(--bad)', 'הדביקי קישור Apps Script'); return; }
  if (!state.cloudUrl) { setNote('var(--bad)', 'צריך כתובת שרת (ענן).'); return; }
  setNote('var(--ink-3)', 'כותב לשיטס…');
  try {
    await registerScriptUrl();   // also turns on auto-write from now on
    const r = await fetch(cloudBase() + '/api/writeback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script_url: state.writeUrl, count_id: state.countId })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('שגיאה ' + r.status));
    setNote('var(--ok)', `✅ נכתב לשיטס — ${j.written} פאות (עמודות: נסרק / תאריך / עמדה). מכאן זה נכתב אוטומטית.`);
  } catch (e) {
    setNote('var(--bad)', '❌ ' + e.message);
  }
}

document.addEventListener('DOMContentLoaded', init);
