/* =====================================================================
 * WigsStock – Inventory Barcode Scanner
 * ---------------------------------------------------------------------
 * Reconciles physically-scanned wigs against a Google-Sheets export.
 * No build step, no dependencies. Works offline once the page is loaded.
 * Camera scanning uses the native BarcodeDetector API when available;
 * a hardware "keyboard-wedge" scanner works everywhere via the input.
 * ===================================================================== */

'use strict';

/* ---------- Status model ----------
 * A wig carries one status. The vocabulary is user-editable in Settings: each
 * status has a Hebrew label (what the UI shows) and an `inStore` flag (does it
 * mean the wig should physically be in the store — i.e. counts as inventory).
 * The `key` is the canonical value, matching whatever the Google Sheet's status
 * column contains. Any status seen in the sheet that isn't in the vocabulary is
 * auto-added so the manager can label it and mark whether it's in-store. */
const IN_STOCK = 'in-stock';
const DEFAULT_STATUSES = [
  { key: 'other',              label: 'Other',              inStore: false },
  { key: 'in-stock',           label: 'In Stock',           inStore: true  },
  { key: 'sold',               label: 'Sold',               inStore: false },
  { key: 'returned',           label: 'Returned',           inStore: false },
  { key: 'personal-use',       label: 'Personal Use',       inStore: false },
  { key: 'damaged',            label: 'damaged',            inStore: false },
  { key: 'consignment',        label: 'Consignment',        inStore: true  },
  { key: 'inventory-reserved', label: 'Inventory Reserved', inStore: false },
  { key: 'ordered',            label: 'Ordered',            inStore: false },
  { key: 'order-reserved',     label: 'Order Reserved',     inStore: false },
  { key: 'wish-list',          label: 'Wish List',          inStore: false },
  { key: 'barter',             label: 'Barter',             inStore: false },
  { key: 'fix-return',         label: 'Fix-Return',         inStore: false },
  { key: 'missing',            label: 'Missing',            inStore: false }
];
// Effective vocabulary: the user's edited list if any, else the defaults.
function statusVocab() { return (state.statusVocab && state.statusVocab.length) ? state.statusVocab : DEFAULT_STATUSES; }
function statusMeta(key) { return statusVocab().find(s => s.key === key) || null; }
function statusLabel(key) { const m = statusMeta(key); return m ? m.label : (key || '—'); }
function isInStore(status) { const m = statusMeta(status); return m ? !!m.inStore : false; }
// Promote the vocabulary to an editable copy (so edits don't mutate the shared default).
function ensureVocabCopy() {
  if (!state.statusVocab || !state.statusVocab.length) {
    state.statusVocab = statusVocab().map(s => ({ key: s.key, label: s.label, inStore: !!s.inStore }));
  }
  return state.statusVocab;
}
// Make sure a status key exists in the vocabulary (used when importing the sheet).
function ensureStatus(key) {
  if (!key || statusMeta(key)) return;
  ensureVocabCopy().push({ key, label: key, inStore: false });
}
// Canonicalize a free-text status into a stable key. Lower-cases, trims, and
// collapses spaces/underscores to a single hyphen — so the sheet's "In Stock",
// "in stock" and "in-stock" all resolve to the one key `in-stock` instead of
// spawning three look-alike statuses. Non-latin text (e.g. Hebrew) is left as
// its own key, matching the old behavior.
function normStatusKey(s) {
  return String(s == null ? '' : s)
    .trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// One-time cleanup that folds the historical duplicate statuses onto the
// canonical vocabulary. Idempotent: running it on an already-clean state is a
// no-op, so it's safe to call on every load and on every settings pull.
// Returns true if it actually changed the vocabulary.
function migrateStatusVocab() {
  const canonical = DEFAULT_STATUSES.map(s => ({ key: s.key, label: s.label, inStore: !!s.inStore }));
  const byKey = {}; canonical.forEach(s => { byKey[s.key] = s; });
  const before = JSON.stringify(state.statusVocab);
  const old = Array.isArray(state.statusVocab) ? state.statusVocab : [];
  const extra = [];
  for (const s of old) {
    if (!s || !s.key) continue;
    const ck = normStatusKey(s.key);
    if (byKey[ck]) {
      // A duplicate of a canonical status — keep the manager's "in-store" choice
      // (OR it in, so a checked look-alike survives the merge).
      if (s.inStore) byKey[ck].inStore = true;
    } else if (!extra.some(e => e.key === ck) && ck) {
      // A genuinely custom status the user added — preserve it (still deletable).
      extra.push({ key: ck, label: s.label || s.key, inStore: !!s.inStore });
    }
  }
  state.statusVocab = canonical.concat(extra);
  return JSON.stringify(state.statusVocab) !== before;
}

// Remap the per-wig status maps (local inventory + synced card overrides) onto
// the canonical keys, so a wig imported as "in stock" now matches `in-stock`.
function migrateStatusData() {
  const fix = (map) => {
    if (!map) return;
    for (const bc in map) {
      const nk = normStatusKey(map[bc]);
      if (nk && nk !== map[bc]) map[bc] = nk;
    }
  };
  fix(state.inventory);
  fix(state.statusOverrides);
}

// Run the full status cleanup once per device (schema v2). The vocabulary and
// overrides are cloud-synced, so pushing the cleaned copy heals every station.
function migrateStatuses() {
  if (state.statusSchemaV >= 2) { migrateStatusVocab(); return; }
  migrateStatusVocab();
  migrateStatusData();
  state.statusSchemaV = 2;
}

// Legacy export — the current set of status keys.
const KNOWN_STATUSES = DEFAULT_STATUSES.map(s => s.key);

// Deployed cloud backend — used by default so the app syncs out of the box.
const DEFAULT_CLOUD_URL = 'https://wigsstock-sync.benzi-naor.workers.dev';
const DEFAULT_COUNT_ID = 'main';

const APP_VERSION = '1.17.7';
// NOTE: this changelog is visible to EVERY station (Settings → גרסאות). Keep the
// notes generic — never describe the permissions / manager / block / user-
// management system here, or regular stations learn it exists.
const CHANGELOG = [
  { v: '1.17.7', notes: [
    'שינויי סטטוס ושמות שנערכו באפליקציה נכתבים עכשיו לשיטס אוטומטית (עמודת "סטטוס (עודכן)") — בלי צורך בלחיצה ידנית על "כתיבה לשיטס"'
  ] },
  { v: '1.17.6', notes: [
    'כל השעות באפליקציה מוצגות עכשיו לפי שעון החנות (ישראל) — גם במכשיר שנמצא בחו"ל'
  ] },
  { v: '1.17.5', notes: [
    'שעת הסריקה מוצגת עכשיו בכל מקום: עמודת "שעה" בטבלאות הדוח (תקין / מסומן אחרת / לא מוכר), שדה "שעת סריקה" בכרטיס הפאה, ועמודות זמן בקבצי הייצוא'
  ] },
  { v: '1.17.4', notes: [
    'שינויי הסטטוס מוצגים עכשיו גם בדוח — כולל מי שינה, מתי, מאיזה סטטוס ולאיזה',
    'בייצוא ובדוח: הקשה על ברקוד פותחת את כרטיס הפאה — גם בתצוגת שינויי הסטטוס'
  ] },
  { v: '1.17.3', notes: [
    'ברקוד לא מוכר (חלון קופץ): הסריקה כבר לא נשמרת אוטומטית — היא נשמרת רק אחרי אישור "שמור בכל זאת"',
    'כשהחלון פתוח הסריקה מושהית — תזוזה של המצלמה כבר לא מעלימה את החלון או שומרת סריקות ברקע'
  ] },
  { v: '1.17.2', notes: [
    'גיליון חדש בייצוא — "שינויי סטטוס": כל הפאות שסומנו בסטטוס אחר מהאפליקציה, עם הסטטוס המקורי מהשיטס לצד החדש',
    'גיליון "עדכוני סטטוס" כבר לא מציע להחזיר למלאי פאות שסומנו בכוונה בסטטוס אחר'
  ] },
  { v: '1.17.1', notes: [
    'תיקון: לחיצה ארוכה על כפתור הסריקה (לבחירת מצב סטטוס) כבר לא פותחת בטעות את תפריט בחירת-הטקסט של המערכת — התפריט נפתח בשחרור האצבע'
  ] },
  { v: '1.17.0', notes: [
    'התראה על סריקת ברקוד לא מוכר — בהגדרות → התנהגות אפשר לבחור בין חלון קופץ (עם מחיקת הסריקה) לבין הבזק + צליל',
    'מצב "סריקה לפי סטטוס": לחיצה ארוכה על כפתור הסריקה מסמנת כל פאה שנסרקת בסטטוס שנבחר (בנוסף לספירה, בלי לגעת בסטטוס המקורי). פס כתום מראה שהמצב פעיל',
    'דוח הספירה מציג פילוח של הפאות החסרות והמסומנות-אחרת לפי הסטטוס המקורי, וגיליון "פילוח חסרים" נוסף לייצוא',
    'תיקון: המספרים כבר לא נתקעים על ערך ישן בפתיחה — המלאי מתרענן מהשיטס אוטומטית בכל חזרה לאפליקציה',
    'תיקון: עדכוני גרסה נוחתים מהר ואמין יותר על כל המכשירים'
  ] },
  { v: '1.16.4', notes: [
    'ניקוי וסידור רשימת הסטטוסים: סטטוסים כפולים מוזגו אוטומטית, וכל סטטוס ניתן עכשיו לעריכה ולמחיקה'
  ] },
  { v: '1.16.3', notes: [
    'שיפורים ותיקונים כלליים'
  ] },
  { v: '1.16.2', notes: [
    'שיפורים ותיקונים כלליים'
  ] },
  { v: '1.16.1', notes: [
    'שיפורי יציבות'
  ] },
  { v: '1.16.0', notes: [
    'שיפורים בסנכרון בין העמדות וביציבות'
  ] },
  { v: '1.15.0', notes: [
    'שיפורים בהגדרות ובגיבוי הנתונים'
  ] },
  { v: '1.14.0', notes: [
    'מנוע סריקה חדש (zxing-cpp/WASM): תגי הברקוד של הפאות (Code 128) נסרקים עכשיו במצלמה — המנוע הישן פספס אותם גם בתמונה חדה',
    'המנוע הישן נשאר כגיבוי אוטומטי לדפדפנים בלי WebAssembly; סורק חיצוני והקלדה לא הושפעו'
  ] },
  { v: '1.13.4', notes: [
    'תיקון אמיתי לבאג "ממתינות": הסנכרון תמיד עבד — אבל התגית לא התרעננה אחרי סנכרון רקע, אז היא נתקעה על מספר ישן. עכשיו היא מתעדכנת נכון ל-0',
    'כפתור "עדכן עכשיו" כבר לא נתקע על "מעדכן…" — נוסף רענון-גיבוי'
  ] },
  { v: '1.13.3', notes: [
    'אפשר ללחוץ על מונה "ממתינות" כדי לאלץ סנכרון מיידי — והוא מראה בדיוק למה זה נתקע (אין חיבור / כתובת שגויה / רשת איטית)',
    'מנגנון "שומר" שמשחרר סנכרון תקוע אוטומטית אחרי 15 שניות'
  ] },
  { v: '1.13.2', notes: [
    'תיקון: מונה "ממתינות לסנכרון" יכל להיתקע אם בקשת רשת "נתקעה" (רשת סלולרית חלשה) — נוסף timeout שמבטיח שהסנכרון תמיד מתאושש וממשיך לנסות עד שהכל עולה'
  ] },
  { v: '1.13.1', notes: [
    'כתובת ה-Apps Script (כתיבה לשיטס) נטענת עכשיו מהשרת — לא "נעלמת" יותר אם נוקה האחסון או פתחת בדפדפן אחר',
    'המצלמה משתחררת גם במחשב כשעוברים לחלון/אפליקציה אחרת (לא רק בטלפון), וחוזרת כשחוזרים ללשונית הסריקה'
  ] },
  { v: '1.13.0', notes: [
    'ההגדרות מסתנכרנות בין כל העמדות דרך השרת — צבע, מצב כהה, צליל, אנימציה, טאב פתיחה, שמות פאות, שינויי סטטוס ומודל הסטטוסים. שינוי בעמדה אחת מופיע בכולן.',
    'רק שם העמדה (וכתובת/מפתח השרת ושם הספירה) נשארים מקומיים למכשיר.',
    'תיקון: כתיבה חזרה לשיטס (עמודות נסרק/תאריך/עמדה/שם) נכשלה בשקט על שרת/מסד נתונים חדש — ה-Worker יוצר עכשיו את הטבלאות לבד'
  ] },
  { v: '1.12.1', notes: [
    'סדר בהגדרות: "מראה" (צבע/כהה/אנימציה) הופרד מ"התנהגות" (צליל/טאב פתיחה), והאקורדיונים סודרו לפי נושא',
    'בוררי הצליל וטאב הפתיחה — חמישה בשורה אחת'
  ] },
  { v: '1.12.0', notes: [
    'בחירת טאב פתיחה בהגדרות — איזה מסך ייפתח כשמפעילים את האפליקציה'
  ] },
  { v: '1.11.2', notes: [
    'שורת הכותרת בטבלאות הדוח נעוצה עם רקע אטום — שורות לא "מבצבצות" מבעדה',
    'הדוחות מציגים את כל השורות (לא רק 500 הראשונות)'
  ] },
  { v: '1.11.1', notes: [
    'תיקון: כפתור הסגירה בכרטיס הפאה כיסה את שם הפאה'
  ] },
  { v: '1.11.0', notes: [
    'פתיח לוגו מונפש בכל פתיחת אפליקציה',
    'הלוגו הקטן למעלה מונפש כל הזמן — לחיצה עליו פותחת את הפתיח המלא',
    'מתג בהגדרות לכיבוי תנועת הלוגו הקטן (הפתיח עצמו תמיד פועל)',
    'כתיבה חזרה לשיטס כוללת עכשיו גם עמודת שם (ושינויי סטטוס מהכרטיס)',
    'כפתור "הזן" במסך הסריקה (במקום "רשום")'
  ] },
  { v: '1.10.0', notes: [
    'כרטיס הפאה: שם ליד הברקוד (ניתן לעריכה) וסטטוס שניתן לשנות ישירות מהכרטיס',
    'ניהול סטטוסים בהגדרות — שם לכל סטטוס וסימון מה נחשב "בחנות"; סטטוסים חדשים מהשיטס נוספים לבד',
    'הדוחות מציגים גם את שם הפאה (לא רק ברקוד), כולל ברשימת החסרות',
    'תוקן באג הגלילה בדוחות — האקורדיונים לא נסגרים/קופצים יותר בזמן גלילה',
    'טעינת שם הפאה מעמודת שם בגיליון (אם קיימת)',
    'אוחדה הלשון: "סטטוס" בכל מקום (במקום "סטטוס בשיטס")'
  ] },
  { v: '1.9.0', notes: [
    'כרטיס מוצר לכל פאה — הקשה על ברקוד פותחת כרטיס עם סטטוס ופרטים (תשתית לשם/מחיר/היסטוריה בהמשך)',
    'בחירת צליל סריקה בהגדרות (קלאסי / עדין / סורק / פעמון / שקט)',
    'עמוד המלאי עוצב מחדש — קומפקטי ומכובד, בלי מסגרות צבע',
    'תיקון צבעי כפתורים שלא תאמו לערכת הנושא'
  ] },
  { v: '1.8.0', notes: [
    'בורר ערכות צבע גלובלי בהגדרות (כולל ורוד) + מצב כהה',
    'עמוד המלאי עוצב מחדש — מספר גדול ומכובד ורשימה נקייה, בלי חלונית פנימית',
    'עמוד הייצוא: כפתור Excel אחד יוקרתי + ייצוא לכל קטגוריה בנפרד, בלי CSV והסברים',
    'עמוד הדוחות נוקה מהסברים, כל הקטגוריות סגורות כברירת מחדל'
  ] },
  { v: '1.7.1', notes: [
    'תיקון עדכונים "תקועים" — קבצי הליבה נמשכים תמיד טריים מהרשת, ובדיקת עדכון יזומה בכל פתיחה'
  ] },
  { v: '1.7.0', notes: [
    'עיצוב מחדש יוקרתי — ערכת אייקוני קו אחידה בכל המסכים במקום אימוג\'ים',
    'ניווט תחתון בסגנון בנקאי: כפתור הסריקה במרכז, עגול ומוגבה',
    'תגי סטטוס מעודנים ואחידים, וכרטיסי דוח נקיים יותר',
    'טאב המלאי נוקה מהסברים מיותרים — פשוט הנתונים'
  ] },
  { v: '1.6.1', notes: [
    'כפתור סריקה בשדה החיפוש שבדוח — סורקים פאה ורואים מיד את הסטטוס שלה (בלי לרשום סריקה)',
    'כרטיס סטטוס לפאה בודדת: תקין / חסרה / מסומנת אחרת / לא מוכרת, כולל העמדה שסרקה'
  ] },
  { v: '1.6.0', notes: [
    'חיפוש חי בדוח — מקלידים ברקוד ורואים מיד באיזו קטגוריה הוא',
    'לחיצה על ריבוע בדאשבורד פותחת וקופצת ישר לנתונים שלו',
    'פילוח לפי עמדה — כמה כל עובדת סרקה',
    'כפתורי בטל/החזר (Undo/Redo) לסריקות + רשימת "סריקות אחרונות" עם ביטול מהיר',
    'מונה "ממתינות לסנכרון" גלוי במסך הסריקה',
    'ייצוא ל-Excel אמיתי (xlsx) — בלי ג\'יבריש בעברית',
    'תצוגה מסודרת של כל הדוחות בתוך האפליקציה (לא רק הורדה)',
    'התאמת ברקוד עמידה יותר (רווחים/אפסים מובילים)'
  ] },
  { v: '1.5.3', notes: ['המצלמה משתחררת אוטומטית כשעוברים לאפליקציה אחרת (לא נשארת תפוסה)', 'המצלמה נכבית לבד אחרי 2 דקות ללא סריקה'] },
  { v: '1.5.2', notes: ['תיקון הפלאש בטלפונים עם כמה עדשות — מחפש אוטומטית את העדשה עם הפנס ומדליק אותה', 'מצב הפלאש נקרא מהחומרה (לא "דולק" כשאין אור)'] },
  { v: '1.5.1', notes: ['פתיחת מצלמה עמידה יותר — ניסיון חוזר עם הגדרות פשוטות כשהמצלמה תפוסה', 'הודעות שגיאה ברורות למצלמה (תפוסה / אין הרשאה / אין מצלמה)'] },
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
  lastResetSeen: 0,  // cloud reset generation this device has applied
  sessionLog: [],    // recent scans on THIS device: [{code, ts, kind}] (newest last, capped)
  batchMode: false,  // show the live recent-scans list on the scan tab
  apiKey: '',        // optional shared secret (only needed if the Worker enforces one)
  accent: '',        // brand accent theme key (see ACCENTS; '' = default)
  dark: false,       // dark appearance
  sound: '',         // scan sound profile key (see SOUNDS; '' = classic)
  names: {},         // barcode -> wig name typed in the app (local, wins over the sheet)
  invNames: {},      // barcode -> wig name read from the sheet's name column (if any)
  statusOverrides: {}, // barcode -> status changed from the wig card (survives sheet reload)
  statusMeta: {},    // barcode -> { by, at }  (who changed the status from the app, and when)
  statusVocab: null, // user-edited status vocabulary ([{key,label,inStore}]); null = defaults
  statusSchemaV: 0,  // local marker: has the one-time status-dedup migration run? (see migrateStatuses)
  logoAnim: true,    // constant motion of the small header logo (splash always plays regardless)
  defaultTab: 'scan',// which tab opens on app launch
  unknownAlert: 'popup', // how to alert on an unrecognized scan: 'popup' (blocking) | 'flash' (device-local)
  lastSettingsAt: 0  // newest shared-settings timestamp this device has applied (local bookkeeping)
};

// The five tabs, in nav order — used for the "default tab" picker in Settings.
const TABS = [
  { id: 'scan',     label: 'סריקה' },
  { id: 'report',   label: 'דוח' },
  { id: 'load',     label: 'מלאי' },
  { id: 'export',   label: 'ייצוא' },
  { id: 'settings', label: 'הגדרות' }
];
function defaultTab() { return TABS.some(t => t.id === state.defaultTab) ? state.defaultTab : 'scan'; }

/* ---------- Access control (admins) ----------
 * Admin status comes from the SERVER — it holds the admin names (the ADMIN_NAMES
 * secret) and returns our rank via /api/claim-name. The names are deliberately
 * NOT shipped in this bundle, so no one can read who the admins are from the app.
 * Rank 0 = regular station; rank >= 1 can reset/restore/manage and sees the
 * sensitive settings. A management action needs the actor to strictly outrank the
 * target. The server is the real gate; this just shapes the UI. */
function normName(s) { return String(s || '').trim().replace(/[׳’′ʼ]/g, "'"); }
// IMPORTANT: the admin names are NOT shipped to the browser — the SERVER holds
// them (ADMIN_NAMES secret) and tells us our rank via /api/claim-name. So no one
// can read who the admins are from the app. We only cache what the server said
// about OUR own station.
function isAdmin() { return (stationClaim.rank || 0) >= 1; }

// Live claim state for this station (from /api/claim-name): our rank (0 = not an
// admin), whether we own our name, and whether the admin blocked us. Rank starts
// at 0 so sensitive settings stay hidden until the server confirms otherwise.
let stationClaim = { owner: true, blocked: false, taken: false, rank: 0 };

/* ---------- Per-wig helpers ----------
 * Effective status = a card override if one was set, else the sheet's value.
 * Effective name = an in-app edit, else the sheet's name column, else empty. */
function statusOf(bc) {
  if (state.statusOverrides && bc in state.statusOverrides) return state.statusOverrides[bc];
  return state.inventory[bc];
}
function effInv() {
  const ov = state.statusOverrides;
  if (!ov || !Object.keys(ov).length) return state.inventory;
  const out = Object.assign({}, state.inventory);
  for (const bc in ov) out[bc] = ov[bc];
  return out;
}
function isKnownWig(bc) {
  return (bc in state.inventory) || !!(state.statusOverrides && bc in state.statusOverrides);
}
function wigName(bc) {
  return (state.names && state.names[bc]) || (state.invNames && state.invNames[bc]) || '';
}

/* ---------- Appearance / brand themes ----------
 * Changing --primary re-themes the whole app (buttons, nav, FAB, active tab,
 * links, progress) since everything reads that one token — so a theme is global
 * by construction. Dark mode overrides the neutral tokens in CSS. */
const ACCENTS = {
  blue:   { name: 'כחול',   v: 'oklch(0.55 0.11 210)' },
  pink:   { name: 'ורוד',   v: 'oklch(0.62 0.16 350)' },
  purple: { name: 'סגול',   v: 'oklch(0.55 0.16 300)' },
  teal:   { name: 'טורקיז', v: 'oklch(0.60 0.10 190)' },
  rose:   { name: 'רוזה',   v: 'oklch(0.60 0.17 18)' },
  green:  { name: 'ירוק',   v: 'oklch(0.56 0.12 155)' }
};
function accentKey() { return ACCENTS[state.accent] ? state.accent : 'blue'; }
function applyTheme() {
  const root = document.documentElement;
  root.style.setProperty('--primary', ACCENTS[accentKey()].v);
  root.setAttribute('data-theme', state.dark ? 'dark' : 'light');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.dark ? '#191920' : '#ffffff';
}

// Jump to Settings and expand the Google-Sheets section (the one place to load).
function openSheetSettings() {
  navigate('settings');
  setTimeout(() => {
    const head = $$('#panel-settings .acc-head').find(h => /גוגל שיטס/.test(h.textContent));
    if (head && head.parentElement) {
      head.parentElement.classList.add('open');
      head.parentElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 60);
}

const LS_KEY = 'wigsstock_v1';

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  scheduleSettingsPush();   // no-op unless a synced setting actually changed
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(state, JSON.parse(raw));
  } catch (e) {}
  // Fold legacy duplicate statuses onto the canonical vocabulary before anything
  // reads it (idempotent — safe on already-clean state).
  migrateStatuses();
  // Baseline the settings signature so early/benign save()s don't push local
  // settings over the server's — only genuine user changes push after this.
  seedSettingsSig();
}

/* ---------- Small DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

/* ---------- In-app dialogs ----------
 * The app NEVER uses the browser's native alert()/confirm() — those are
 * unstyled Chrome chrome and break the brand. Every message and confirmation
 * goes through this styled modal (buttons, colors and radius from our own CSS
 * tokens). uiAlert → Promise<void>; uiConfirm → Promise<boolean>. */
function uiDialog(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const existing = document.querySelector('.ui-dialog');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.className = 'modal ui-dialog';
    const hasCancel = opts.cancelText !== null && opts.cancelText !== undefined;
    const isPrompt = !!opts.prompt;
    wrap.innerHTML =
      `<div class="modal-card dlg-card" role="alertdialog" aria-modal="true">` +
        (opts.title ? `<div class="dlg-title">${esc(opts.title)}</div>` : '') +
        `<div class="dlg-msg">${esc(opts.message || '').replace(/\n/g, '<br>')}</div>` +
        (isPrompt ? `<input class="dlg-input" type="text" autocomplete="off" value="${esc(opts.value || '')}" maxlength="${opts.maxlength || 24}">` : '') +
        `<div class="dlg-actions">` +
          (hasCancel ? `<button type="button" class="btn ghost dlg-cancel">${esc(opts.cancelText || 'ביטול')}</button>` : '') +
          `<button type="button" class="btn${opts.danger ? ' danger' : ''} dlg-ok">${esc(opts.confirmText || 'אישור')}</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('.dlg-input');
    const okVal = () => (isPrompt ? (input ? input.value : '') : true);
    const finish = (val) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(isPrompt ? null : false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(okVal()); }
    };
    wrap.querySelector('.dlg-ok').addEventListener('click', () => finish(okVal()));
    const cancelBtn = wrap.querySelector('.dlg-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(isPrompt ? null : false));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(isPrompt ? null : false); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { const b = input || wrap.querySelector('.dlg-ok'); if (b) { b.focus(); if (input) input.select(); } }, 20);
  });
}
function uiAlert(message, opts) {
  opts = opts || {};
  return uiDialog({ title: opts.title, message, confirmText: opts.confirmText || 'הבנתי', cancelText: null, danger: opts.danger });
}
function uiConfirm(message, opts) {
  opts = opts || {};
  return uiDialog({ title: opts.title, message, confirmText: opts.confirmText || 'אישור', cancelText: opts.cancelText || 'ביטול', danger: opts.danger });
}
// Styled text prompt (never the native prompt()). Resolves to the string, or
// null if cancelled/dismissed.
function uiPrompt(message, opts) {
  opts = opts || {};
  return uiDialog({ prompt: true, title: opts.title, message, value: opts.value || '',
    maxlength: opts.maxlength, confirmText: opts.confirmText || 'אישור', cancelText: opts.cancelText || 'ביטול' });
}

/* Normalize a barcode for matching. The sheet import and every scan pass through
 * this, so the two sides always normalize identically:
 *   - strip a BOM and Google-Sheets' leading text apostrophe ('01234)
 *   - trim and remove any inner whitespace a scanner might inject
 *   - drop leading zeros on purely-numeric codes so "01234" == "1234"
 * (No barcodes currently start with 0, but this keeps future ones from
 *  splitting into a false "missing" + "unknown" pair.) */
function normBarcode(s) {
  s = String(s == null ? '' : s).replace(/^﻿/, '').replace(/^'/, '').trim().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) s = s.replace(/^0+(\d)/, '$1');
  return s;
}

/* ---------- Icon system ----------
 * One coherent set of Lucide-style line icons (24×24, stroke=currentColor),
 * matching the bottom-nav / settings icons. Replaces ad-hoc emoji so the whole
 * UI reads as one premium system. `ic(name)` returns inline SVG; color comes
 * from the surrounding text color (or a modifier class). */
const ICONS = {
  check:    '<circle cx="12" cy="12" r="9"/><path d="m8.3 12 2.6 2.6L15.7 9"/>',
  x:        '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  alert:    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  help:     '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 3.4 2.3c-.8.4-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  copy:     '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2"/>',
  bars:     '<line x1="5" y1="20" x2="5" y2="13"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="9"/>',
  users:    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user:     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  file:     '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  undo:     '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  redo:     '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  list:     '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.5" y2="6"/><line x1="3.5" y1="12" x2="3.5" y2="12"/><line x1="3.5" y1="18" x2="3.5" y2="18"/>',
  zap:      '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  camera:   '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  reset:    '<path d="M3 2v6h6"/><path d="M3.5 9a9 9 0 1 0 2.1-3.4L3 8"/>',
  cloud:    '<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  folder:   '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  trash:    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh:  '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10"/><path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  search:   '<circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/>',
  edit:     '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  close:    '<path d="M18 6 6 18M6 6l12 12"/>',
  scan:     '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  stop:     '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  cloudOff: '<path d="M18 10h-1.3A8 8 0 0 0 6 6M2 2l20 20M6 10a5 5 0 0 0 0 10h11"/>',
  upload:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 9 5-5 5 5"/><path d="M12 4v12"/>',
  archive:  '<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  info:     '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  chevron:  '<path d="m15 18-6-6 6-6"/>',
  palette:  '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.9-4.5-9-10-9z"/>'
};
function ic(name, cls) {
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

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
  const nameHints = ['שם', 'name', 'דגם', 'model', 'תיאור', 'description', 'desc', 'כותרת', 'title'];

  let barcodeCol = header.findIndex(h => barcodeHints.some(x => h.includes(x)));
  let statusCol = header.findIndex(h => statusHints.some(x => h.includes(x)));
  let nameCol = header.findIndex(h => nameHints.some(x => h.includes(x)));

  // If a real header wasn't found, treat everything as data with default columns.
  const looksLikeHeader = barcodeCol !== -1 || statusCol !== -1 || nameCol !== -1 ||
    header.some(h => isNaN(Number(h)) && h !== '');

  if (barcodeCol === -1) barcodeCol = 0;
  if (statusCol === -1) statusCol = 1;
  if (nameCol === barcodeCol || nameCol === statusCol) nameCol = -1;   // don't reuse a column

  return { barcodeCol, statusCol, nameCol, hasHeader: looksLikeHeader };
}

function importInventory(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { added: 0, error: 'הקובץ ריק' };
  const map = detectColumns(rows);
  const dataRows = map.hasHeader ? rows.slice(1) : rows;

  const inv = {}, invNames = {};
  let added = 0, unknownStatus = 0;
  for (const r of dataRows) {
    const barcode = normBarcode(r[map.barcodeCol] || '');
    let status = normStatusKey(r[map.statusCol] || '');   // canonical key: "In Stock" → in-stock (no duplicate)
    if (!barcode) continue;
    if (!status) status = 'other';
    else if (!statusMeta(status)) { unknownStatus++; ensureStatus(status); }   // keep the real value; let the manager label it
    inv[barcode] = status;
    if (map.nameCol != null && map.nameCol >= 0) {
      const nm = (r[map.nameCol] || '').trim();
      if (nm) invNames[barcode] = nm;
    }
    added++;
  }
  state.inventory = inv;
  state.invNames = invNames;
  save();
  return { added, unknownStatus, hasNames: Object.keys(invNames).length, barcodeCol: map.barcodeCol, statusCol: map.statusCol, header: map.hasHeader ? rows[0] : null };
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
  const inv = effInv(), scans = effectiveScans();
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

// Undo/redo command stack (this device's own scans). Cloud counts are absolute
// and idempotent, so decrementing then re-pushing never double-counts elsewhere.
const undoStack = [];
const redoStack = [];

function recordScan(rawCode, opts) {
  opts = opts || {};
  const code = normBarcode(rawCode);
  if (!code) return;
  if (!hasStation()) { applyStationGate(); return; }   // never record without a station
  if (stationClaim.blocked) { applyBlockGate(); return; }   // blocked by the admin

  // While the unknown-barcode prompt is open, ignore EVERY scan — nothing may
  // be recorded behind the manager's back, and a camera re-fire must not
  // replace (and so dismiss) the open dialog. Self-heals if the dialog was
  // closed by any other means.
  if (unknownPromptOpen) {
    if (document.querySelector('.ui-dialog')) return;
    unknownPromptOpen = false;
  }

  // Debounce: ignore the same code fired twice within 1.2s (camera repeats).
  // A confirmed unknown re-record must bypass it — the prompt scan itself
  // already primed the debounce, and a fast approval would be swallowed.
  const now = Date.now();
  if (!opts.fromHistory && !opts.confirmedUnknown && code === lastScanCode && now - lastScanTs < 1200) return;
  lastScanCode = code; lastScanTs = now;

  const known = code in state.inventory;
  // Unknown barcode in popup mode: ask FIRST, record only on explicit approval.
  // A mis-scan must never be saved automatically.
  if (!known && !opts.confirmedUnknown && !opts.fromHistory && (state.unknownAlert || 'popup') === 'popup') {
    unknownPromptOpen = true;
    promptUnknownScan(code);
    return;
  }

  const existing = state.scans[code];
  if (existing) existing.count++;
  else state.scans[code] = { count: 1, first: now };
  if (cloudEnabled()) { state.dirty[code] = true; schedulePush(); }

  // Scan-to-status mode: stamp the chosen status on a known wig too (a synced
  // override — never touches the sheet's original value). The physical scan is
  // still recorded above, so the wig also counts in the inventory count.
  // Unknown codes fall through to the normal unknown handling / alert.
  if (scanStatusMode && known) applyScanStatusOverride(code, scanStatusMode);
  const kind = !known ? 'unknown' : existing ? 'dup' : 'ok';
  logSession(code, kind);
  if (!opts.fromHistory) { undoStack.push({ code }); redoStack.length = 0; updateUndoRedo(); }
  save();

  showScanFeedback(code, !!existing);
  renderReport();
  renderScanStats();
  renderPending();
  armCameraIdle();   // scanning is activity — push the auto-off back
}

// Reverse one scan of `code` on this device (used by Undo and per-item removal).
function unrecordScan(code) {
  const s = state.scans[code];
  if (!s) return false;
  if (s.count > 1) s.count--; else delete state.scans[code];
  if (cloudEnabled()) { state.dirty[code] = true; schedulePush(); }
  // drop the most recent matching entry from the session log
  for (let i = state.sessionLog.length - 1; i >= 0; i--) {
    if (state.sessionLog[i].code === code) { state.sessionLog.splice(i, 1); break; }
  }
  save();
  renderReport(); renderScanStats(); renderPending(); renderSessionLog();
  return true;
}

function undoScan() {
  const a = undoStack.pop();
  if (!a) return;
  if (unrecordScan(a.code)) { redoStack.push(a); updateUndoRedo(); flashBanner(ic('undo') + ' בוטלה סריקה: ' + esc(a.code), 'dup'); }
  else updateUndoRedo();
}

function redoScan() {
  const a = redoStack.pop();
  if (!a) return;
  recordScan(a.code, { fromHistory: true });
  undoStack.push(a);
  updateUndoRedo();
}

function updateUndoRedo() {
  const u = $('#undoBtn'), r = $('#redoBtn');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}

// Keep a capped, persisted log of this device's scans for the batch/recent list.
function logSession(code, kind) {
  state.sessionLog.push({ code, ts: Date.now(), kind });
  if (state.sessionLog.length > 400) state.sessionLog = state.sessionLog.slice(-400);
  renderSessionLog();
}

// msg may contain safe inline SVG/markup; callers escape any dynamic text.
function flashBanner(msg, kind) {
  const banner = $('#scanBanner');
  if (!banner) return;
  banner.className = 'scan-banner ' + (kind || '');
  banner.innerHTML = `<div class="msg">${msg}</div>`;
}

// Worker-facing feedback is deliberately status-agnostic: a scanned wig just
// shows "scanned successfully". The sheet status (sold/consignment/…) is only
// surfaced to the manager in the report, not to the scanning worker.
function showScanFeedback(code, wasDuplicate) {
  const banner = $('#scanBanner');
  const known = code in state.inventory;
  let kind, glyph, msg;
  if (!known) { kind = 'unknown'; glyph = 'help'; msg = 'ברקוד לא מוכר — לא בקובץ'; }
  else if (wasDuplicate) { kind = 'dup'; glyph = 'copy'; msg = 'כבר נסרק'; }
  else { kind = 'ok'; glyph = 'check'; msg = 'נסרק בהצלחה'; }
  if (known && scanStatusMode) msg += ' · סומן: ' + statusLabel(scanStatusMode);
  banner.className = 'scan-banner ' + kind;
  banner.innerHTML = `<div class="code">${esc(code)}</div><div class="msg">${ic(glyph)} ${msg}</div>`;
  // flash the scan line green on a successful read (red otherwise)
  const frame = document.querySelector('.scan-frame');
  if (frame && (kind === 'ok' || kind === 'dup')) {
    frame.classList.add('hit');
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => frame.classList.remove('hit'), 700);
  }
  beep(kind);
  if (navigator.vibrate) navigator.vibrate(kind === 'ok' ? 40 : [40, 60, 40]);
  // Prominent alert on an unrecognized scan (style chosen in Settings).
  if (!known) notifyUnknown(code);
}

/* ---------- Unknown-barcode alert ----------
 * A scan that isn't in the inventory file is easy to miss mid-count, so we
 * surface it loudly. Two styles, chosen per device in Settings:
 *   'popup' — a blocking styled dialog offering to discard the mis-scan
 *   'flash' — a big red screen flash + strong sound/vibration (non-blocking) */
function notifyUnknown(code) {
  // Popup mode is handled BEFORE the scan is recorded (promptUnknownScan) —
  // here only the non-blocking flash style, for scans that were recorded.
  if ((state.unknownAlert || 'popup') === 'flash') {
    unknownFlash(code);
    if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 200]);
  }
}
// Ask about an unrecognized barcode BEFORE recording it. While the dialog is
// open recordScan ignores all scans (see unknownPromptOpen), so a moving
// camera can't re-fire and replace the dialog or save anything silently.
// Dismissing the dialog = not saved — the safe default.
let unknownPromptOpen = false;
function promptUnknownScan(code) {
  const banner = $('#scanBanner');
  if (banner) {
    banner.className = 'scan-banner unknown';
    banner.innerHTML = `<div class="code">${esc(code)}</div><div class="msg">${ic('help')} ברקוד לא מוכר — ממתין להחלטה</div>`;
  }
  beep('unknown');
  if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
  uiConfirm('הברקוד ' + code + ' לא נמצא בקובץ המלאי.\nייתכן שזו טעות סריקה. לשמור בכל זאת?', {
    title: 'ברקוד לא מוכר', danger: true, confirmText: 'שמור בכל זאת', cancelText: 'אל תשמור'
  }).then(keep => {
    unknownPromptOpen = false;
    if (keep) recordScan(code, { confirmedUnknown: true });
    else flashBanner(ic('check') + ' הסריקה לא נשמרה: ' + esc(code), 'dup');
  });
}
function unknownFlash(code) {
  let o = document.getElementById('unknownFlash');
  if (!o) {
    o = document.createElement('div');
    o.id = 'unknownFlash';
    o.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;' +
      'flex-direction:column;gap:10px;background:rgba(220,38,38,.9);color:#fff;font-size:1.7rem;font-weight:800;' +
      'text-align:center;pointer-events:none;opacity:0;transition:opacity .1s;';
    document.body.appendChild(o);
  }
  o.innerHTML = ic('help') + '<div>ברקוד לא מוכר</div><div style="font-size:1.1rem;direction:ltr">' + esc(code) + '</div>';
  o.style.opacity = '1';
  clearTimeout(unknownFlash._t);
  unknownFlash._t = setTimeout(() => { o.style.opacity = '0'; }, 900);
}

/* ---------- Scan-to-status mode ----------
 * Long-press the scan tab to pick a status; every wig scanned afterwards is
 * ALSO stamped with it (a synced override — the sheet's original value is never
 * touched) while still counting in the inventory count. Device-local and
 * transient: it resets on a full reload so it can't linger by accident. */
let scanStatusMode = null;
// Track who changed a wig's status from the app and when — shown in the report
// and the "שינויי סטטוס" export so a marking session is fully auditable.
function stampStatusMeta(bc, removed) {
  state.statusMeta = state.statusMeta || {};
  if (removed) delete state.statusMeta[bc];
  else state.statusMeta[bc] = { by: (state.session || '').trim() || deviceId(), at: Date.now() };
}
function applyScanStatusOverride(bc, status) {
  state.statusOverrides = state.statusOverrides || {};
  const removed = state.inventory[bc] === status;
  if (removed) delete state.statusOverrides[bc];  // matches the sheet → no override
  else state.statusOverrides[bc] = status;
  stampStatusMeta(bc, removed);
}
function setScanStatusMode(status) {
  scanStatusMode = status || null;
  renderScanModeBar();
  renderReport(true);
}
function renderScanModeBar() {
  const bar = document.getElementById('scanModeBar');
  // amber FAB from any tab whenever a special scan mode is on
  const fab = document.getElementById('tab-scan');
  if (fab) fab.classList.toggle('mode-on', !!scanStatusMode);
  if (!bar) return;
  if (!scanStatusMode) { bar.className = 'hidden'; bar.style.cssText = ''; bar.innerHTML = ''; return; }
  bar.className = '';
  bar.style.cssText = 'position:sticky;top:6px;z-index:20;display:flex;align-items:center;justify-content:space-between;' +
    'gap:10px;margin:8px 0;padding:11px 13px;border-radius:12px;background:#f59e0b;color:#111;font-weight:800;' +
    'box-shadow:0 4px 14px rgba(245,158,11,.5)';
  bar.innerHTML = '<span>' + ic('edit') + ' מצב סריקה מיוחד — כל פאה מסומנת כ־<b>' + esc(statusLabel(scanStatusMode)) + '</b></span>' +
    '<button class="btn small-btn" id="scanModeOff" style="background:#111;color:#fff;flex:none">סיום</button>';
  const off = document.getElementById('scanModeOff');
  if (off) off.onclick = () => setScanStatusMode(null);
}
function openScanStatusPicker() {
  const vocab = statusVocab();
  const wrap = document.createElement('div');
  wrap.className = 'modal ui-dialog';
  const opts = vocab.map(s =>
    '<button type="button" class="btn secondary scan-st-opt" data-st="' + esc(s.key) + '"' +
    (s.key === scanStatusMode ? ' style="outline:2px solid #2563eb"' : '') + '>' + esc(s.label) + '</button>').join('');
  wrap.innerHTML = '<div class="modal-card dlg-card">' +
    '<div class="dlg-title">' + ic('edit') + ' סריקה לפי סטטוס</div>' +
    '<div class="dlg-msg">בחרי סטטוס — כל פאה שתסרקי תסומן בו (ותיספר כרגיל). לא נוגע בסטטוס המקורי בשיטס.</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0;max-height:50vh;overflow:auto">' + opts + '</div>' +
    '<div class="dlg-actions">' +
      '<button type="button" class="btn ghost" data-st-cancel>ביטול</button>' +
      (scanStatusMode ? '<button type="button" class="btn" data-st-normal>חזרה לספירה רגילה</button>' : '') +
    '</div></div>';
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-st-cancel]').onclick = close;
  const normal = wrap.querySelector('[data-st-normal]');
  if (normal) normal.onclick = () => { setScanStatusMode(null); close(); };
  wrap.querySelectorAll('[data-st]').forEach(b => b.onclick = () => {
    setScanStatusMode(b.getAttribute('data-st')); close(); navigate('scan');
  });
}
// Fire `fn` on a long press (touch or mouse) and swallow the click that follows,
// so long-pressing the scan tab opens the picker instead of navigating.
function attachLongPress(el, fn) {
  if (!el) return;
  let timer = null, longReady = false, suppressClick = false;
  const begin = () => {
    suppressClick = false; longReady = false;
    timer = setTimeout(() => { longReady = true; if (navigator.vibrate) navigator.vibrate(15); }, 500);
  };
  // Open the menu on RELEASE, not while the finger is still down — otherwise the
  // dialog appears under the held finger and Android turns it into a text
  // selection (the Copy / Select-all menu). Clearing any stray selection too.
  const finish = () => {
    clearTimeout(timer);
    if (!longReady) return;
    longReady = false; suppressClick = true;
    try { const s = window.getSelection(); if (s) s.removeAllRanges(); } catch (e) {}
    fn();
  };
  const cancel = () => { clearTimeout(timer); longReady = false; };
  el.addEventListener('touchstart', begin, { passive: true });
  el.addEventListener('touchend', finish);
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', begin);
  el.addEventListener('mouseup', finish);
  el.addEventListener('mouseleave', cancel);
  // swallow the click that a touchend/mouseup synthesizes right after a long-press
  el.addEventListener('click', (e) => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); suppressClick = false; } }, true);
}
function renderUnknownAlert() {
  const wrap = $('#unknownAlertPicker');
  if (!wrap) return;
  const cur = state.unknownAlert || 'popup';
  const opts = [{ k: 'popup', l: 'חלון קופץ' }, { k: 'flash', l: 'הבזק + צליל' }];
  wrap.innerHTML = opts.map(o =>
    '<button class="seg-opt' + (o.k === cur ? ' active' : '') + '" data-ua="' + o.k + '">' + o.l + '</button>').join('');
  wrap.querySelectorAll('[data-ua]').forEach(b => b.addEventListener('click', () => {
    state.unknownAlert = b.getAttribute('data-ua'); save(); renderUnknownAlert();
  }));
}
let hitTimer = null;

/* Web-Audio beep so workers get audible confirmation without a sound file.
 * Several selectable profiles: an elegant chime, the classic tone, and a sharp
 * real-scanner blip. Each maps ok/dup/unknown to a note sequence. */
const SOUNDS = {
  classic: { name: 'קלאסי', type: 'sine',     dur: .18, gain: .15, ok: [880],       dup: [620],  unknown: [320] },
  soft:    { name: 'עדין',  type: 'sine',     dur: .22, gain: .12, ok: [659, 988],  dup: [523],  unknown: [294] },
  scanner: { name: 'סורק',  type: 'square',   dur: .07, gain: .07, ok: [2100],      dup: [1600], unknown: [500] },
  bell:    { name: 'פעמון', type: 'triangle', dur: .30, gain: .12, ok: [1319, 1760], dup: [988], unknown: [440] },
  off:     { name: 'שקט', off: true }
};
function soundKey() { return SOUNDS[state.sound] ? state.sound : 'classic'; }
let audioCtx = null;
function beep(kind) {
  const s = SOUNDS[soundKey()];
  if (!s || s.off) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = s[kind] || s.ok;
    notes.forEach((f, i) => {
      const t0 = audioCtx.currentTime + i * s.dur * 0.85;
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.type = s.type; osc.frequency.value = f;
      osc.connect(gain); gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(s.gain, t0);
      gain.gain.exponentialRampToValueAtTime(.0008, t0 + s.dur);
      osc.start(t0); osc.stop(t0 + s.dur);
    });
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
 * Primary engine: zxing-cpp compiled to WebAssembly (zxing-wasm) — decodes
 * real-world print (the store's Code 128 wig tags) that the old JS ZXing port
 * consistently missed. The JS port (zxing.min.js) stays as a fallback for the
 * rare browser without working WebAssembly. Native BarcodeDetector proved
 * unreliable on some Android builds, so we don't use it.
 * Camera access requires a secure context (https:// or localhost) — opening
 * the file directly from disk on a phone will NOT get the camera; host it
 * (e.g. GitHub Pages) for camera scanning. Hardware scanners work anywhere.
 */
let cameraOn = false, zxingReader = null, cameraStream = null, scanTimer = null, scanCanvas = null, scanCtx = null;
let wasmEngineReady = null;   // Promise<boolean>: true → use zxing-wasm, false → old JS ZXing
let useWasmEngine = false;
let scanBusy = false;         // a wasm decode is in flight (it's async — never overlap)
// Auto-release the camera so it never stays busy for other apps: stop it after
// a stretch with no scans, and whenever the app goes to the background.
let cameraIdleTimer = null, cameraResumeOnVisible = false;
const CAMERA_IDLE_MS = 120000;   // 2 min with no scan → free the camera

function showCamStart(msg) {
  const s = $('#camStart'); if (s) s.classList.remove('hidden');
  if (msg !== undefined) $('#cameraNote').textContent = msg;
}

function setBannerLive() {
  const b = $('#scanBanner');
  if (b) { b.className = 'scan-banner'; b.innerHTML = `<div class="msg muted">${ic('camera')} מצלמה פעילה — כוונו ברקוד למסגרת</div>`; }
}

function makeReader() {
  const hints = new Map();
  const F = ZXing.BarcodeFormat;
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS,
    [F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.QR_CODE]);
  hints.set(ZXing.DecodeHintType.TRY_HARDER, true);   // critical for real barcodes
  return new ZXing.BrowserMultiFormatReader(hints, 100);
}

// Same format list as makeReader(), in zxing-wasm naming.
const WASM_READER_OPTS = {
  formats: ['Code128', 'Code39', 'EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'ITF', 'Codabar', 'QRCode'],
  tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
  maxNumberOfSymbols: 1,
};

/* Initialize the zxing-cpp WASM engine once. The single-file build inlines the
 * .wasm as base64 (window.__ZXING_WASM_B64, set by build-single.js); the
 * hosted build fetches zxing_reader.wasm next to the app (cached by the
 * service worker for offline). Resolves false → caller falls back to the old
 * JS ZXing engine. */
function initWasmEngine() {
  if (wasmEngineReady) return wasmEngineReady;
  wasmEngineReady = (async () => {
    if (!window.ZXingWASM || typeof WebAssembly === 'undefined') return false;
    try {
      const overrides = {};
      if (window.__ZXING_WASM_B64) {
        const bin = atob(window.__ZXING_WASM_B64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        overrides.wasmBinary = bytes.buffer;
      } else {
        overrides.locateFile = (p) => /\.wasm$/.test(p) ? 'zxing_reader.wasm' : p;
      }
      await ZXingWASM.prepareZXingModule({ overrides, fireImmediately: true });
      return true;
    } catch (e) { return false; }   // wasm blocked/missing → old engine still scans
  })();
  return wasmEngineReady;
}

async function startCamera() {
  const btn = $('#cameraBtn');
  if (cameraOn) { stopCamera(); return; }

  if (!isSecureContextForCamera()) {
    showCamStart('למצלמה צריך כתובת מאובטחת (https) — פתחי מהלינק, לא מקובץ מקומי. בינתיים: סורק חיצוני או הקלדה.');
    return;
  }
  if ((!window.ZXingWASM && !window.ZXing) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamStart('הדפדפן לא תומך בגישה למצלמה. השתמשי בסורק חיצוני או בהקלדה.');
    return;
  }

  const video = $('#video');
  $('#reader').classList.remove('hidden');
  $('#camStart').classList.add('hidden');
  $('#cameraNote').textContent = '';
  btn.innerHTML = ic('stop');
  cameraOn = true;
  setBannerLive();   // show immediately so it never looks stuck on "opening…"

  try {
    // Warm up the WASM engine while the camera is opening (both are async).
    const wasmReadyP = initWasmEngine();
    cameraStream = await getCameraStream();
    torchOn = false; torchProbed = false;
    video.srcObject = cameraStream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    useWasmEngine = await wasmReadyP;
    zxingReader = useWasmEngine ? null : makeReader();
    scanCanvas = document.createElement('canvas');
    scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    scanTick();   // our own decode loop — guarantees frames are actually decoded
    updateFlashButton();
    armCameraIdle();
  } catch (e) {
    cameraOn = false;
    btn.innerHTML = ic('camera');
    showCamStart(cameraErrorMessage(e));
  }
}

/* Open the rear camera, degrading gracefully. "Could not start video source"
 * (NotReadableError) is almost always the camera being held by another app or
 * browser tab / an installed PWA instance — retrying with plainer constraints
 * often succeeds. We stop early on a real permission denial. */
async function getCameraStream() {
  const attempts = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: { ideal: 'environment' } } },
    { video: true },
  ];
  let lastErr;
  for (const c of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(c); }
    catch (e) {
      lastErr = e;
      if (/NotAllowed|denied|permission/i.test(e.name + ' ' + (e.message || ''))) throw e;
    }
  }
  throw lastErr;
}

// Turn a getUserMedia failure into actionable Hebrew guidance.
function cameraErrorMessage(e) {
  const s = (e && (e.name + ' ' + (e.message || ''))) || '';
  if (/NotAllowed|denied|permission/i.test(s)) return 'הקש/י על הכפתור כדי לאשר מצלמה';
  if (/NotReadable|Could not start|in use|busy|track ?start/i.test(s))
    return 'המצלמה תפוסה — סגרי אפליקציות/טאבים אחרים שמשתמשים במצלמה (כולל האפליקציה המותקנת), ונסי שוב. בינתיים: סורק חיצוני או הקלדה.';
  if (/NotFound|Overconstrained|Requested device/i.test(s))
    return 'לא נמצאה מצלמה מתאימה במכשיר. השתמשי בסורק חיצוני או בהקלדה.';
  return 'לא ניתן לגשת למצלמה: ' + ((e && (e.message || e.name)) || e);
}

/* Grab the current video frame and try to decode it. tryHarder/tryRotate
 * handle rotation/imperfect framing. Decoding the full frame (capped width)
 * each ~90ms is reliable across devices. The WASM decode is async, so the
 * next tick is only armed after the current decode finishes (scanBusy). */
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
      if (useWasmEngine) {
        if (!scanBusy) {
          scanBusy = true;
          const frame = scanCtx.getImageData(0, 0, cw, ch);
          ZXingWASM.readBarcodes(frame, WASM_READER_OPTS).then((found) => {
            scanBusy = false;
            // Camera may have been stopped while the decode was in flight.
            if (cameraOn && found && found[0] && found[0].text) recordScan(found[0].text);
          }).catch(() => { scanBusy = false; });
        }
      } else {
        const src = new ZXing.HTMLCanvasElementLuminanceSource(scanCanvas);
        const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
        try {
          const res = zxingReader.decodeBitmap(bmp);
          if (res) recordScan(res.getText());
        } catch (e) { /* NotFoundException — no barcode this frame */ }
      }
    }
  } catch (e) { /* frame not ready */ }
  scanTimer = setTimeout(scanTick, 90);
}

function isSecureContextForCamera() {
  return window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
}

function stopCamera() {
  cameraOn = false;
  scanBusy = false;
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (zxingReader) { try { zxingReader.reset(); } catch (e) {} zxingReader = null; }
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const v = $('#video'); if (v) { try { v.srcObject = null; } catch (e) {} }
  $('#cameraBtn').innerHTML = ic('camera');
  const s = $('#camStart'); if (s) s.classList.remove('hidden');
  torchOn = false; torchProbed = false;
  if (cameraIdleTimer) { clearTimeout(cameraIdleTimer); cameraIdleTimer = null; }
  const fb = $('#flashBtn'); if (fb) { fb.classList.add('hidden'); fb.classList.remove('active'); }
}

// (Re)start the inactivity countdown. Called when the camera opens and on every
// scan, so the timer only fires after a real gap with no scanning.
function armCameraIdle() {
  if (cameraIdleTimer) { clearTimeout(cameraIdleTimer); cameraIdleTimer = null; }
  if (!cameraOn) return;
  cameraIdleTimer = setTimeout(() => {
    if (!cameraOn) return;
    stopCamera();
    showCamStart('המצלמה כובתה אוטומטית עקב חוסר שימוש — הקש/י כדי להפעיל שוב');
  }, CAMERA_IDLE_MS);
}

/* Camera flash / torch.
 * The flash LED is wired only to the main rear sensor. On multi-lens phones
 * (Xiaomi/MIUI etc. expose 3-4 rear lenses) getUserMedia may hand back an
 * ultra-wide / macro / depth lens that has no LED, so getCapabilities().torch
 * is false even though the phone has a flash. So: don't judge support up front
 * — show the button while the camera is on; on tap, if the current lens has no
 * torch, enumerate the cameras and switch to the first rear lens that exposes
 * one. Probe at most once per session (torchProbed). */
let torchOn = false, torchProbed = false;
function torchTrack() { return cameraStream && cameraStream.getVideoTracks ? cameraStream.getVideoTracks()[0] : null; }
function torchOnTrack(track) {
  try { const c = track && track.getCapabilities && track.getCapabilities(); return !!(c && c.torch); }
  catch (e) { return false; }
}
// The torch capability is sometimes reported a beat after the stream comes up.
function settleTorch(track) {
  if (torchOnTrack(track)) return Promise.resolve(true);
  return new Promise(res => setTimeout(() => res(torchOnTrack(track)), 260));
}
// Prefer the main rear sensor; push selfie and wide/tele/macro/depth lenses down.
function rearScore(label) {
  label = (label || '').toLowerCase(); let s = 0;
  if (/back|rear|environment|world/.test(label)) s += 10;
  if (/front|user|selfie|face/.test(label)) s -= 20;
  if (/(^|\D)0(\D|$)/.test(label)) s += 3;                       // "camera2 0, facing back" = main sensor
  if (/wide|ultra|tele|macro|depth|mono|bokeh/.test(label)) s -= 2;
  return s;
}
function updateFlashButton() {
  const btn = $('#flashBtn'); if (!btn) return;
  if (cameraOn) btn.classList.remove('hidden');
  else { btn.classList.add('hidden'); btn.classList.remove('active'); torchOn = false; torchProbed = false; }
}

// Point #video at a new stream without stopping the decode loop — scanTick reads
// frames off the <video>/canvas, so swapping the stream underneath keeps decoding.
async function bindScanStream(stream) {
  cameraStream = stream;
  const video = $('#video');
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  try { await video.play(); } catch (e) {}
}

// applyConstraints resolves even when the light didn't actually come on, so we
// read the real state back from getSettings().torch.
async function applyTorch(want) {
  const track = torchTrack(); if (!track) return false;
  await track.applyConstraints({ advanced: [{ torch: want }] });
  let on = want;
  try { const st = track.getSettings ? track.getSettings() : {}; if ('torch' in st) on = !!st.torch; } catch (e) {}
  torchOn = on;
  const btn = $('#flashBtn'); if (btn) btn.classList.toggle('active', on);
  return on;
}

async function toggleTorch() {
  const btn = $('#flashBtn'), note = $('#cameraNote');
  const track = torchTrack(); if (!track) return;
  if (note) note.textContent = '';
  try {
    if (torchOn) { await applyTorch(false); return; }                 // turn off
    if (torchOnTrack(track)) { await applyTorch(true); return; }      // current lens has torch
    // Current lens exposes no torch — search the other lenses (once).
    if (torchProbed) { if (note) note.textContent = 'הפלאש לא נתמך במצלמה של המכשיר הזה'; return; }
    if (note) note.textContent = 'מחפש עדשה עם פנס…';
    const found = await findTorchCamera();
    if (note) note.textContent = found ? '' : 'הפלאש לא נתמך במצלמה של המכשיר הזה';
  } catch (e) {
    torchOn = false; if (btn) btn.classList.remove('active');
    if (note) note.textContent = 'הפלאש לא נתמך במצלמה/דפדפן הזה';
  }
}

// Enumerate rear cameras and switch to the first that actually exposes a torch.
async function findTorchCamera() {
  torchProbed = true;
  let curId = '';
  try { curId = (torchTrack().getSettings() || {}).deviceId || ''; } catch (e) {}
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return false; }
  const cands = devs.filter(d => d.kind === 'videoinput' && d.deviceId && d.deviceId !== curId)
                    .sort((a, b) => rearScore(b.label) - rearScore(a.label));
  // Most phones allow only one active rear camera at a time — free the current one.
  if (cameraStream) cameraStream.getTracks().forEach(t => t.stop());
  for (const d of cands) {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } }); }
    catch (e) { continue; }
    const track = stream.getVideoTracks()[0];
    if (await settleTorch(track)) {                 // found a lens with a flash
      await bindScanStream(stream);
      await applyTorch(true);
      return true;
    }
    stream.getTracks().forEach(t => t.stop());
  }
  // No lens exposed a torch — reopen a camera so scanning keeps working.
  await reopenScanCamera(curId);
  return false;
}

// Reopen a camera (the original lens if known) after a failed torch probe.
async function reopenScanCamera(deviceId) {
  const want = deviceId ? { video: { deviceId: { exact: deviceId } } }
                        : { video: { facingMode: { ideal: 'environment' } } };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia(want); }
  catch (e) {
    try { stream = await getCameraStream(); } catch (e2) { return; }
  }
  await bindScanStream(stream);
}

/* =====================================================================
 * Rendering
 * ===================================================================== */
function tableFor(list, cols) {
  if (!list.length) return '<p class="muted small">אין פריטים בקטגוריה זו.</p>';
  const head = cols.map(c => `<th>${c.label}</th>`).join('');
  const body = list.map(item =>          // show every row — the list scrolls inside its box
    '<tr>' + cols.map(c => `<td>${c.render(item)}</td>`).join('') + '</tr>').join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderScanStats() {
  const r = reconcile();
  const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  set('#scanCount', r.totalScanned);
  set('#scanOk', r.ok.length);
  set('#scanWarn', r.foundOther.length);
  set('#scanUnknown', r.unknown.length);
}

// How many scans still wait to reach the cloud (offline queue / in-flight).
function renderPending() {
  const n = cloudEnabled() ? Object.keys(state.dirty).length : 0;
  $$('.pending-badge').forEach(el => {
    el.innerHTML = n ? (ic('cloudOff') + ' ' + n + ' ממתינות') : (cloudEnabled() ? (ic('cloud') + ' מסונכרן') : '');
    el.classList.toggle('hidden', !cloudEnabled());
    el.classList.toggle('pending-on', n > 0);
    el.style.cursor = 'pointer';
    if (n > 0) el.title = 'הקש כדי לסנכרן עכשיו';
    el.onclick = forceSync;   // tap to force a sync and see why it's stuck
  });
  setCloudStatus(n ? 'syncing' : 'ok');
}

// Live "recent scans" list for batch mode — newest first, with quick undo.
function renderSessionLog() {
  const wrap = $('#batchPanel');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !state.batchMode);
  if (!state.batchMode) return;
  const log = state.sessionLog.slice(-60).reverse();
  const cnt = $('#batchCount'); if (cnt) cnt.textContent = state.sessionLog.length;
  const list = $('#batchList');
  if (!list) return;
  if (!log.length) { list.innerHTML = '<p class="muted small center">עדיין לא נסרק דבר בסבב הזה.</p>'; return; }
  const glyph = k => k === 'ok' ? ic('check', 'ok') : k === 'dup' ? ic('copy', 'dup') : ic('help', 'unknown');
  list.innerHTML = log.map(e =>
    `<div class="batch-row"><span class="batch-ico">${glyph(e.kind)}</span>` +
    `<span class="batch-code">${esc(e.code)}</span>` +
    `<button class="batch-undo" data-undo-code="${esc(e.code)}" title="בטל">${ic('close')}</button></div>`
  ).join('');
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
  const inv = effInv(), scans = effectiveScans();
  const totals = {}, scanned = {};
  for (const bc in inv) {
    const st = inv[bc];
    totals[st] = (totals[st] || 0) + 1;
    if (bc in scans) scanned[st] = (scanned[st] || 0) + 1;
  }
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  if (!keys.length) return '<p class="muted small">—</p>';
  const rows = keys.map(st =>
    `<tr><td><span class="tag ${isInStore(st) ? 'instock' : 'other'}">${esc(statusLabel(st))}</span></td>` +
    `<td>${totals[st].toLocaleString()}</td><td>${(scanned[st] || 0).toLocaleString()}</td></tr>`).join('');
  return `<div class="scroll"><table><thead><tr><th>סטטוס</th><th>סה"כ</th><th>נסרקו</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Count a reconciliation list (missing / foundOther / …) by each item's original
// status, so a manager sees at a glance where the wigs came from. Returns
// [[status, count], …] sorted most-common first.
function statusSummaryOf(list) {
  const by = {};
  for (const i of list) {
    const st = i.status != null ? i.status : statusOf(i.barcode);
    by[st] = (by[st] || 0) + 1;
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
// One-line summary for an accordion sub-title, e.g. "In Stock: 129 · Consignment: 62".
// Empty when a single status carries the whole list (the split would add nothing).
function statusSummaryText(list) {
  const rows = statusSummaryOf(list);
  if (rows.length < 2) return '';
  return rows.map(([st, n]) => `${statusLabel(st)}: ${n.toLocaleString()}`).join(' · ');
}

// dd/MM HH:mm for timestamps shown in the report / wig card / exports.
// Always the STORE's clock (Israel), not the viewing device's — a manager
// abroad must see the same times the workers on the floor saw.
const STORE_TZ = 'Asia/Jerusalem';
function fmtDayTime(t) {
  if (!t) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: STORE_TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).replace(',', '');
  } catch (e) {
    const d = new Date(t), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
// Same, with the year — for exports.
function fmtFullDayTime(t) {
  if (!t) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: STORE_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)).replace(',', '');
  } catch (e) { return fmtDayTime(t); }
}
// When was a barcode last scanned — cloud detail first (all stations), then
// this device's own record as a fallback.
function scanTimeOf(bc) {
  const d = state.cloudDetail && state.cloudDetail[bc];
  return (d && d.last) || (state.scans[bc] && state.scans[bc].first) || 0;
}

// In-app status changes (wig card / scan-to-status), fully attributed: which
// wig, from what, to what, by whom and when. Every cell links to the wig card.
function statusChangesTable() {
  const ov = state.statusOverrides || {}, meta = state.statusMeta || {};
  const keys = Object.keys(ov).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!keys.length) return '<p class="muted small">לא בוצעו שינויי סטטוס מהאפליקציה.</p>';
  const fmtAt = (t) => t ? fmtDayTime(t) : '—';
  const rows = keys.map(bc => {
    const m = meta[bc] || {};
    const nm = wigName(bc);
    return '<tr>' +
      `<td><span class="bc-link name-cell" data-wig="${esc(bc)}">${nm ? esc(nm) : '<span class="muted">פאה</span>'}</span></td>` +
      `<td><b class="bc-link" data-wig="${esc(bc)}">${esc(bc)}</b></td>` +
      `<td><span class="tag other">${esc(statusLabel(state.inventory[bc] || ''))}</span></td>` +
      `<td><span class="tag ${isInStore(ov[bc]) ? 'instock' : 'other'}">${esc(statusLabel(ov[bc]))}</span></td>` +
      `<td>${m.by ? esc(m.by) : '<span class="muted">—</span>'}</td>` +
      `<td class="muted small">${fmtAt(m.at)}</td></tr>`;
  }).join('');
  return `<div class="scroll"><table><thead><tr><th>שם</th><th>ברקוד</th><th>מסטטוס</th><th>לסטטוס</th><th>מי</th><th>מתי</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

let reportQuery = '';

// Scans attributed per station, from the cloud's per-barcode station list.
// A barcode touched by two stations counts for each (best we can do from the
// merged view) — labelled as "barcodes scanned" so the meaning is honest.
function stationBreakdown() {
  const detail = state.cloudDetail || {};
  const byStation = {};
  let any = false;
  for (const bc in detail) {
    const d = detail[bc];
    const stations = (d && d.station ? String(d.station) : '').split(',').map(s => s.trim()).filter(Boolean);
    for (const st of stations) { byStation[st] = (byStation[st] || 0) + 1; any = true; }
  }
  // fall back to this device's own scans when there's no cloud detail yet
  if (!any) {
    const me = deviceId();
    const n = Object.keys(state.scans).length;
    if (n) byStation[me] = n;
  }
  const rows = Object.entries(byStation).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<p class="muted small">אין נתוני עמדות עדיין.</p>';
  const me = deviceId();
  const total = rows.reduce((s, [, n]) => s + n, 0);
  const body = rows.map(([st, n]) => {
    const pct = total ? Math.round(n / total * 100) : 0;
    const meTag = st === me ? ' <span class="tag instock">את/ה</span>' : '';
    return `<tr><td>${ic('user', 'muted')} ${esc(st)}${meTag}</td><td>${n.toLocaleString()}</td>` +
      `<td><div class="mini-bar"><div style="width:${pct}%"></div></div><span class="muted small">${pct}%</span></td></tr>`;
  }).join('');
  return `<div class="scroll"><table><thead><tr><th>עמדה / עובדת</th><th>פאות שנסרקו</th><th>חלק</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Lookup scanner (report tab) ----------
 * A lightweight camera overlay that scans ONE barcode into the search box to
 * check a wig's status — it does NOT record a scan. Reuses makeReader() and
 * getCameraStream() but keeps its own stream/timer so it never clashes with
 * the main scan-tab camera (which only runs on the scan tab). */
let lookupStream = null, lookupTimer = null, lookupReader = null, lookupCanvas = null, lookupCtx = null, lookupOn = false;

async function openLookupScan() {
  if (lookupOn) return;
  const overlay = $('#scanOverlay');
  if (!isSecureContextForCamera()) { uiAlert('למצלמה צריך כתובת מאובטחת (https). אפשר גם להקליד את הברקוד ידנית בשדה החיפוש.'); return; }
  if (!window.ZXing || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { uiAlert('הדפדפן לא תומך במצלמה. הקלידי את הברקוד בשדה החיפוש.'); return; }
  overlay.classList.remove('hidden');
  $('#overlayNote').textContent = 'פותח מצלמה…';
  const video = $('#overlayVideo');
  try {
    lookupStream = await getCameraStream();
    video.srcObject = lookupStream;
    video.setAttribute('playsinline', 'true');
    await video.play();
    lookupReader = makeReader();
    lookupCanvas = document.createElement('canvas');
    lookupCtx = lookupCanvas.getContext('2d', { willReadFrequently: true });
    lookupOn = true;
    $('#overlayNote').textContent = 'כוונו ברקוד למסגרת';
    lookupTick();
  } catch (e) {
    $('#overlayNote').textContent = cameraErrorMessage(e);
  }
}

function lookupTick() {
  if (!lookupOn) return;
  const video = $('#overlayVideo');
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (video.readyState >= 2 && vw && vh) {
      const scale = Math.min(1, 1280 / vw);
      const cw = Math.round(vw * scale), ch = Math.round(vh * scale);
      if (lookupCanvas.width !== cw) { lookupCanvas.width = cw; lookupCanvas.height = ch; }
      lookupCtx.drawImage(video, 0, 0, cw, ch);
      const src = new ZXing.HTMLCanvasElementLuminanceSource(lookupCanvas);
      const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
      try {
        const res = lookupReader.decodeBitmap(bmp);
        if (res) { onLookupHit(res.getText()); return; }
      } catch (e) { /* no barcode this frame */ }
    }
  } catch (e) { /* frame not ready */ }
  lookupTimer = setTimeout(lookupTick, 90);
}

function onLookupHit(code) {
  const bc = normBarcode(code);
  closeLookupScan();
  beep('ok');
  if (navigator.vibrate) navigator.vibrate(40);
  reportQuery = bc;
  renderReport();   // re-renders with the lookup status card + filter
}

function closeLookupScan() {
  lookupOn = false;
  if (lookupTimer) { clearTimeout(lookupTimer); lookupTimer = null; }
  if (lookupReader) { try { lookupReader.reset(); } catch (e) {} lookupReader = null; }
  if (lookupStream) { lookupStream.getTracks().forEach(t => t.stop()); lookupStream = null; }
  const v = $('#overlayVideo'); if (v) { try { v.srcObject = null; } catch (e) {} }
  const o = $('#scanOverlay'); if (o) o.classList.add('hidden');
}

/* ---------- Wig product card ----------
 * Every wig is a product identified by its barcode. The card shows and lets you
 * edit its name (next to the barcode) and its status, plus scan/store details.
 * Opened by tapping any barcode. Name and status edits are stored locally and
 * survive a sheet reload (see state.names / state.statusOverrides). */
function wigVerdict(bc) {
  const inInv = isKnownWig(bc);
  const status = inInv ? statusOf(bc) : null;
  const scanned = (effectiveScans()[bc] || {}).count || 0;
  if (!inInv && !scanned) return { cls: 'muted', glyph: 'search', text: 'לא נמצאה', status, scanned, inInv };
  if (!inInv) return { cls: 'unknown', glyph: 'help', text: 'ברקוד לא מוכר', status, scanned, inInv };
  if (isInStore(status) && scanned) return { cls: 'ok', glyph: 'check', text: 'תקין — במלאי ונסרקה', status, scanned, inInv };
  if (isInStore(status) && !scanned) return { cls: 'bad', glyph: 'x', text: 'חסרה — לא נסרקה', status, scanned, inInv };
  if (!isInStore(status) && scanned) return { cls: 'warn', glyph: 'alert', text: 'בחנות אך מסומנת אחרת', status, scanned, inInv };
  return { cls: 'muted', glyph: 'info', text: 'לא אמורה בחנות', status, scanned, inInv };
}

let productBc = '';
function openProductCard(bc) {
  bc = normBarcode(bc);
  if (!bc) return;
  productBc = bc;
  renderProductCard();
  const m = $('#productModal'); if (m) m.classList.remove('hidden');
}
function renderProductCard() {
  const bc = productBc;
  const el = $('#productBody');
  if (!el || !bc) return;
  const v = wigVerdict(bc);
  const d = state.cloudDetail && state.cloudDetail[bc];
  const nm = wigName(bc);
  const field = (label, val) => `<div class="pc-field"><span>${label}</span><b>${val}</b></div>`;
  // status dropdown from the vocabulary (plus the wig's own value if it's unlisted)
  let opts = statusVocab().map(s =>
    `<option value="${esc(s.key)}"${s.key === v.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  if (v.status && !statusMeta(v.status)) opts += `<option value="${esc(v.status)}" selected>${esc(v.status)}</option>`;
  el.innerHTML = `
    <div class="pc-idrow">
      <input id="pcName" class="pc-name" value="${esc(nm)}" placeholder="שם הפאה" autocomplete="off" maxlength="60">
      <div class="pc-bc" title="ברקוד">${esc(bc)}</div>
    </div>
    <div class="pc-verdict ${v.cls}">${ic(v.glyph)} ${esc(v.text)}</div>
    <label class="pc-status">
      <span>סטטוס</span>
      <select id="pcStatus">${opts}</select>
    </label>
    <div class="pc-fields">
      ${field('בחנות', v.inInv && isInStore(v.status) ? 'כן' : 'לא')}
      ${field('נסרקה', v.scanned ? ('כן · ' + v.scanned + ' פעמים') : 'לא')}
      ${d && d.station ? field('עמדה', esc(d.station)) : ''}
      ${scanTimeOf(bc) ? field('שעת סריקה', fmtDayTime(scanTimeOf(bc))) : ''}
    </div>
    <div class="pc-soon">${ic('info')} מחיר והיסטוריה — בקרוב</div>`;
  const nameEl = $('#pcName');
  if (nameEl) {
    const commit = () => setWigName(bc, nameEl.value);
    nameEl.addEventListener('change', commit);
    nameEl.addEventListener('blur', commit);
  }
  const stEl = $('#pcStatus');
  if (stEl) stEl.addEventListener('change', () => setWigStatus(bc, stEl.value));
}
// Save an in-app wig name (empty clears it). Refresh the lists that show names.
function setWigName(bc, name) {
  name = (name || '').trim();
  state.names = state.names || {};
  if (name) state.names[bc] = name; else delete state.names[bc];
  save();
  renderReport(true); renderInventoryStatus();
}
// Change a wig's status from the card. Kept as a local override; if it matches
// the sheet's own value again, the override is dropped so nothing lingers.
function setWigStatus(bc, status) {
  state.statusOverrides = state.statusOverrides || {};
  const removed = state.inventory[bc] === status;
  if (removed) delete state.statusOverrides[bc];
  else state.statusOverrides[bc] = status;
  stampStatusMeta(bc, removed);
  save();
  renderProductCard();                 // verdict + "בחנות" reflect the new status
  renderReport(true); renderScanStats(); renderInventoryStatus();
}
function closeProductCard() { productBc = ''; const m = $('#productModal'); if (m) m.classList.add('hidden'); }

// Status readout for one specific wig — shown when the search query exactly
// identifies a barcode (typed or scanned via the search's camera button).
function lookupCard(query) {
  const bc = normBarcode(query || '');
  if (!bc) return '';
  const inInv = isKnownWig(bc);
  const scans = effectiveScans();
  const scanned = bc in scans ? scans[bc].count : 0;
  const nm = wigName(bc);
  const title = nm ? `${esc(nm)} · ${esc(bc)}` : esc(bc);
  if (!inInv && !scanned) {
    return `<div class="lookup none"><div class="lookup-bc">${ic('search', 'muted')} ${title}</div>` +
      `<div class="lookup-line">לא נמצאה — לא בקובץ המלאי וגם לא נסרקה.</div></div>`;
  }
  const status = inInv ? statusOf(bc) : null;
  let cls, glyph, verdict;
  if (!inInv) { cls = 'unknown'; glyph = 'help'; verdict = 'ברקוד לא מוכר — נסרק אך לא קיים בקובץ'; }
  else if (isInStore(status) && scanned) { cls = 'ok'; glyph = 'check'; verdict = 'תקין — במלאי ונסרקה'; }
  else if (isInStore(status) && !scanned) { cls = 'bad'; glyph = 'x'; verdict = 'חסרה — אמורה בחנות אך לא נסרקה'; }
  else if (!isInStore(status) && scanned) { cls = 'warn'; glyph = 'alert'; verdict = 'בחנות אך מסומנת אחרת'; }
  else { cls = 'muted'; glyph = 'info'; verdict = 'רשומה במלאי, לא אמורה להיות בחנות ולא נסרקה'; }
  const d = state.cloudDetail && state.cloudDetail[bc];
  const station = d && d.station ? `<div class="lookup-line">עמדה: <b>${esc(d.station)}</b></div>` : '';
  return `<div class="lookup ${cls}">
    <div class="lookup-bc bc-link" data-wig="${esc(bc)}">${title}</div>
    <div class="lookup-verdict">${ic(glyph)} ${verdict}</div>
    <div class="lookup-line">סטטוס: <b>${inInv ? esc(statusLabel(status)) : '—'}</b></div>
    <div class="lookup-line">נסרקה: <b>${scanned ? ('כן · ' + scanned + ' פעמים') : 'לא'}</b></div>
    ${station}
  </div>`;
}

// A stable signature of everything that affects the report's markup. When it's
// unchanged (e.g. the 4-second cloud poll returned identical data) we skip the
// rebuild entirely, so open accordions and the scroll position never get stomped
// mid-scroll. Local edits (name/status) pass force=true to always repaint.
let reportSig = null;
function reportSignature(r, q) {
  const meta = state.statusMeta || {};
  let lastChange = 0;
  for (const bc in meta) if (meta[bc] && meta[bc].at > lastChange) lastChange = meta[bc].at;
  return JSON.stringify([q, r.totalInventory, r.totalScanned, r.ok.length, r.missing.length,
    r.foundOther.length, r.unknown.length, r.duplicates.length, r.expectedInStock,
    state.cloudDevices || 0, Object.keys(state.cloudDetail || {}).length,
    Object.keys(state.statusOverrides || {}).length, lastChange]);
}

function renderReport(force) {
  const r = reconcile();
  const el = $('#reportBody');
  if (!r.totalInventory) {
    el.innerHTML = '<div class="card"><p class="muted">עדיין לא נטען מלאי. עברי ללשונית "מלאי" כדי לטעון קובץ, או להגדרות → "מלאי מגוגל שיטס".</p></div>';
    reportSig = null;
    return;
  }

  const q = reportQuery.trim().toLowerCase();
  const sig = reportSignature(r, q);
  if (!force && sig === reportSig && el.children.length) return;   // nothing changed — leave the DOM (and scroll) alone

  // Preserve which accordions the user has open, and the scroll position, across
  // the rebuild (only the report tab's own scroll — never yank another tab).
  const openIds = $$('#reportBody [id^="acc-"]').filter(w => w.querySelector('.acc.open')).map(w => w.id);
  const onReport = !!document.querySelector('#panel-report.active');
  const sx = window.scrollX, sy = window.scrollY;
  reportSig = sig;

  const filt = (list) => q ? list.filter(i =>
    String(i.barcode).toLowerCase().includes(q) || wigName(i.barcode).toLowerCase().includes(q)) : list;
  const nameCol = { label: 'שם', render: i => {
    const nm = wigName(i.barcode);
    return `<span class="bc-link name-cell" data-wig="${esc(i.barcode)}">${nm ? esc(nm) : '<span class="muted">פאה</span>'}</span>`;
  } };
  const bcCol = { label: 'ברקוד', render: i => `<b class="bc-link" data-wig="${esc(i.barcode)}">${esc(i.barcode)}</b>` };
  const statusCol = { label: 'סטטוס', render: i => {
    const st = i.status != null ? i.status : statusOf(i.barcode);
    return `<span class="tag ${isInStore(st) ? 'instock' : 'other'}">${esc(statusLabel(st))}</span>`;
  } };
  const countCol = { label: 'פעמים', render: i => i.count };
  const stationCol = { label: 'עמדה', render: i => {
    const d = state.cloudDetail && state.cloudDetail[i.barcode];
    return d && d.station ? esc(d.station) : '<span class="muted">—</span>';
  } };
  const timeCol = { label: 'שעה', render: i => {
    const t = scanTimeOf(i.barcode);
    return t ? `<span class="muted small">${fmtDayTime(t)}</span>` : '<span class="muted">—</span>';
  } };
  const delCol = { label: '', render: i =>
    `<button class="del-btn" data-del-code="${esc(i.barcode)}" title="מחק סריקה">${ic('trash')}</button>` };
  const expected = r.expectedInStock;
  const pct = expected ? Math.round(r.ok.length / expected * 100) : 0;
  const cloudLine = cloudEnabled()
    ? `<span class="muted small">${ic('cloud','muted')} ${esc(state.countId)} · ${state.cloudDevices || 0} עמדות</span>`
    : `<span class="muted small">מקומי</span>`;

  const fOther = filt(r.foundOther), fMissing = filt(r.missing), fUnknown = filt(r.unknown),
        fDup = filt(r.duplicates), fOk = filt(r.ok);
  const openIf = (n) => q ? n > 0 : false;

  el.innerHTML = `
    <div class="card">
      <div class="rep-head">
        <h2>דוח ספירה</h2>
        <button class="btn ghost small-btn" data-report-refresh>${ic('refresh')} רענן</button>
      </div>
      ${cloudLine}
      <div class="progress" title="${pct}%"><div class="progress-bar" style="width:${pct}%"></div></div>
      <p class="muted small">נסרקו <b>${r.ok.length.toLocaleString()}</b> מתוך <b>${expected.toLocaleString()}</b> שאמורות להיות בחנות (<b>${pct}%</b>)</p>
      <div class="stats">
        <div class="stat total" data-jump="acc-status" tabindex="0">${ic('file', 'stat-ic')}<div class="num">${r.totalInventory.toLocaleString()}</div><div class="lbl">סה"כ במלאי</div></div>
        <div class="stat" data-jump="acc-ok" tabindex="0">${ic('scan', 'stat-ic')}<div class="num">${r.totalScanned.toLocaleString()}</div><div class="lbl">נסרקו פיזית</div></div>
        <div class="stat ok" data-jump="acc-ok" tabindex="0">${ic('check', 'stat-ic')}<div class="num">${r.ok.length.toLocaleString()}</div><div class="lbl">תקין · במלאי ונסרק</div></div>
        <div class="stat bad" data-jump="acc-missing" tabindex="0">${ic('x', 'stat-ic')}<div class="num">${r.missing.length.toLocaleString()}</div><div class="lbl">חסר · לא נסרק</div></div>
        <div class="stat warn" data-jump="acc-other" tabindex="0">${ic('alert', 'stat-ic')}<div class="num">${r.foundOther.length.toLocaleString()}</div><div class="lbl">מסומן אחרת</div></div>
        <div class="stat unknown" data-jump="acc-unknown" tabindex="0">${ic('help', 'stat-ic')}<div class="num">${r.unknown.length.toLocaleString()}</div><div class="lbl">לא מוכר</div></div>
      </div>
      <div class="search-row">
        <span class="search-ic">${ic('search', 'muted')}</span>
        <input id="reportSearch" class="search-input" inputmode="search" autocomplete="off" placeholder="חיפוש / בדיקת סטטוס של פאה" value="${esc(reportQuery)}">
        <button id="reportScanBtn" class="icon-btn" title="סרוק ברקוד לבדיקת סטטוס">${ic('camera')}</button>
        ${q ? `<span class="muted small">נמצאו: ${(fOther.length + fMissing.length + fUnknown.length + fOk.length).toLocaleString()}</span>` : ''}
      </div>
      ${lookupCard(reportQuery)}
    </div>

    <div id="acc-other">${accCard(ic('alert', 'warn') + ' בחנות אך מסומן אחרת', r.foundOther.length,
      statusSummaryText(fOther), tableFor(fOther, [nameCol, bcCol, statusCol, stationCol, timeCol, delCol]), openIf(fOther.length))}</div>

    <div id="acc-missing">${accCard(ic('x', 'bad') + ' חסרות', r.missing.length,
      statusSummaryText(fMissing), tableFor(fMissing, [nameCol, bcCol, statusCol]), openIf(fMissing.length))}</div>

    <div id="acc-unknown">${accCard(ic('help', 'unknown') + ' ברקודים לא מוכרים', r.unknown.length,
      '', tableFor(fUnknown, [nameCol, bcCol, countCol, stationCol, timeCol, delCol]), openIf(fUnknown.length))}</div>

    <div id="acc-dup">${accCard(ic('copy', 'dup') + ' כפילויות', r.duplicates.length, '',
      tableFor(fDup, [nameCol, bcCol, countCol]), openIf(fDup.length))}</div>

    <div id="acc-changes">${accCard(ic('edit', 'warn') + ' שינויי סטטוס', Object.keys(state.statusOverrides || {}).length,
      '', statusChangesTable())}</div>

    <div id="acc-ok">${accCard(ic('check', 'ok') + ' תקין', r.ok.length, '',
      tableFor(fOk, [nameCol, bcCol, statusCol, stationCol, timeCol, delCol]), openIf(fOk.length))}</div>

    <div id="acc-stations">${accCard(ic('users') + ' פילוח לפי עמדה / עובדת', Object.keys(state.cloudDetail || {}).length ? (state.cloudDevices || '') : '',
      '', stationBreakdown())}</div>

    <div id="acc-status">${accCard(ic('bars') + ' פילוח לפי סטטוס', r.totalInventory.toLocaleString(),
      '', statusBreakdownTable())}</div>
  `;

  // restore the accordions the user had open, and the scroll they were at
  openIds.forEach(id => { const w = document.getElementById(id); const a = w && w.querySelector('.acc'); if (a) a.classList.add('open'); });
  if (onReport && (window.scrollX !== sx || window.scrollY !== sy)) window.scrollTo(sx, sy);

  const search = $('#reportSearch');
  if (search) {
    search.oninput = () => { reportQuery = search.value; renderReport(true); };
    if (q) { const pos = search.value.length; search.focus(); try { search.setSelectionRange(pos, pos); } catch (e) {} }
  }
  const scanBtn = $('#reportScanBtn');
  if (scanBtn) scanBtn.onclick = openLookupScan;
}

function renderInventoryStatus() {
  const n = Object.keys(state.inventory).length;
  const el = $('#invStatus');
  if (!el) return;
  if (!n) {
    el.innerHTML = `
      <div class="inv-empty">
        <div class="inv-empty-ic">${ic('file')}</div>
        <div class="inv-empty-title">אין מלאי טעון</div>
        <p class="muted">המלאי נטען מגוגל שיטס בהגדרות ומתעדכן אוטומטית בכל העמדות.</p>
        <button class="btn" id="invEmptyLoad">${ic('cloud')} טען מגוגל שיטס</button>
      </div>`;
    const go = $('#invEmptyLoad');
    if (go) go.onclick = openSheetSettings;
    return;
  }
  const counts = {};
  for (const s of Object.values(effInv())) counts[s] = (counts[s] || 0) + 1;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, c]) =>
    `<div class="inv-row">
      <span class="inv-name"><span class="inv-dot ${isInStore(s) ? 'in' : ''}"></span>${esc(statusLabel(s))}</span>
      <span class="inv-count">${c.toLocaleString()}</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="inv-hero">
      <span class="inv-total">${n.toLocaleString()}</span>
      <span class="inv-total-lbl">פאות במלאי</span>
    </div>
    <div class="inv-list">${rows}</div>`;
}

/* =====================================================================
 * Export
 * ---------------------------------------------------------------------
 * Each report is built once as a rows array (header + data). The same
 * array feeds three sinks: a CSV download, a real .xlsx download (opens
 * cleanly in Excel with Hebrew — no charset guessing), and an in-app
 * preview table. Build the data once, render it three ways.
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

/* ---------- Report data builders (header row first) ---------- */
function dataReconciliation() {
  const r = reconcile();
  const rows = [['barcode', 'name', 'category', 'status', 'scan_count', 'scan_time']];
  const push = (list, cat) => list.forEach(i =>
    rows.push([i.barcode, wigName(i.barcode), cat, i.status || statusOf(i.barcode) || '', (state.scans[i.barcode]?.count) || (i.count || ''), fmtDayTime(scanTimeOf(i.barcode))]));
  push(r.foundOther, 'in-store-but-flagged');
  push(r.missing, 'missing');
  push(r.unknown, 'unknown-barcode');
  push(r.ok, 'ok');
  return rows;
}
// Summary tab: how many missing / flagged wigs came from each original status
// (e.g. missing → In Stock 129, Consignment 62). Managers use this to tell a
// real disappearance (In Stock) from an expected absence (Consignment out).
function dataMissingBreakdown() {
  const r = reconcile();
  const rows = [['category', 'status', 'count']];
  const add = (list, cat) => statusSummaryOf(list).forEach(([st, n]) =>
    rows.push([cat, statusLabel(st), n]));
  add(r.missing, 'missing');
  add(r.foundOther, 'in-store-but-flagged');
  return rows;
}
// Audit tab: every wig whose status was changed from the app (wig card or
// scan-to-status mode) — original sheet value next to the new one, so the
// manager sees exactly what was done. Only true changes appear here: an
// override matching the sheet's own value is dropped at the source.
function dataStatusChanges() {
  const rows = [['barcode', 'name', 'original_status', 'new_status', 'changed_by', 'changed_at']];
  const ov = state.statusOverrides || {}, meta = state.statusMeta || {};
  Object.keys(ov).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(bc => {
    const m = meta[bc] || {};
    rows.push([bc, wigName(bc), statusLabel(state.inventory[bc] || ''), statusLabel(ov[bc]),
      m.by || '', m.at ? fmtFullDayTime(m.at) : '']);
  });
  return rows;
}
function dataUpdates() {
  const r = reconcile();
  const ov = state.statusOverrides || {};
  const rows = [['barcode', 'name', 'current_status', 'suggested_status', 'reason']];
  // Deliberate in-app changes (scan-to-status / wig card) are the manager's own
  // decision — never suggest reverting those back to in-stock.
  r.foundOther.filter(i => !(i.barcode in ov))
    .forEach(i => rows.push([i.barcode, wigName(i.barcode), i.status, IN_STOCK, 'נסרק בחנות']));
  r.missing.forEach(i => rows.push([i.barcode, wigName(i.barcode), IN_STOCK, 'missing', 'רשום in-stock אך לא נסרק']));
  return rows;
}
function dataScans() {
  const rows = [['barcode', 'scan_count', 'last_scan_time']];
  Object.entries(effectiveScans()).forEach(([bc, s]) => rows.push([bc, s.count, fmtDayTime(scanTimeOf(bc))]));
  return rows;
}
function dataStations() {
  const detail = state.cloudDetail || {};
  const by = {};
  for (const bc in detail) {
    (String(detail[bc].station || '').split(',').map(s => s.trim()).filter(Boolean)).forEach(st => by[st] = (by[st] || 0) + 1);
  }
  if (!Object.keys(by).length) by[deviceId()] = Object.keys(state.scans).length;
  const rows = [['station', 'barcodes_scanned']];
  Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([st, n]) => rows.push([st, n]));
  return rows;
}

/* ---------- Minimal, dependency-free .xlsx writer ----------
 * An .xlsx is a ZIP of XML parts. We store parts uncompressed (a valid ZIP
 * "stored" entry needs only a CRC-32), and write every cell as an inline
 * string or number — so no shared-strings table and no deflate needed. This
 * is enough for Excel/Sheets to open it with perfect UTF-8 Hebrew. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const UTF8 = new TextEncoder();
function xmlCell(v, col, row) {
  const ref = colName(col) + row;
  if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}" t="n"><v>${v}</v></c>`;
  const s = String(v == null ? '' : v);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
}
function colName(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; }
function sheetXml(rows) {
  const body = rows.map((r, ri) =>
    `<row r="${ri + 1}">` + r.map((v, ci) => xmlCell(v, ci, ri + 1)).join('') + '</row>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}
// sheets: [{name, rows}]
function buildXlsx(sheets) {
  const parts = [];
  parts.push(['[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + `</Types>`]);
  parts.push(['_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  parts.push(['xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    sheets.map((s, i) => `<sheet name="${esc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets></workbook>`]);
  parts.push(['xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `</Relationships>`]);
  sheets.forEach((s, i) => parts.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]));

  // assemble a "stored" (uncompressed) ZIP
  const chunks = [], central = [];
  let offset = 0;
  const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  for (const [name, content] of parts) {
    const nameBytes = UTF8.encode(name);
    const data = UTF8.encode(content);
    const crc = crc32(data);
    const local = [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0));
    chunks.push(new Uint8Array(local), nameBytes, data);
    const cen = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
    central.push(new Uint8Array(cen), nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  central.forEach(c => centralSize += c.length);
  const end = [].concat(u32(0x06054b50), u16(0), u16(0), u16(parts.length), u16(parts.length),
    u32(centralSize), u32(centralStart), u16(0));
  const all = [...chunks, ...central, new Uint8Array(end)];
  let total = 0; all.forEach(a => total += a.length);
  const out = new Uint8Array(total);
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
function downloadXlsx(filename, sheets) {
  const blob = new Blob([buildXlsx(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Export actions ---------- */
// Each report as an {icon, title, rows} builder — used for the single "export
// all" workbook, the per-category export, and the in-app preview.
const EXPORT_SHEETS = {
  recon:    { icon: 'file',    title: 'דוח התאמה',     build: dataReconciliation },
  summary:  { icon: 'bars',    title: 'פילוח חסרים',   build: dataMissingBreakdown },
  changes:  { icon: 'edit',    title: 'שינויי סטטוס',  build: dataStatusChanges },
  updates:  { icon: 'edit',    title: 'עדכוני סטטוס',  build: dataUpdates },
  stations: { icon: 'users',   title: 'פילוח לפי עמדה', build: dataStations },
  scans:    { icon: 'archive', title: 'סריקות גולמיות', build: dataScans }
};
const EXPORT_ORDER = ['recon', 'summary', 'changes', 'updates', 'stations', 'scans'];

// One Excel workbook with every report as its own tab.
function exportExcel() {
  downloadXlsx(stamp() + '_report.xlsx',
    EXPORT_ORDER.map(k => ({ name: EXPORT_SHEETS[k].title, rows: EXPORT_SHEETS[k].build() })));
}
// Export a single category as its own one-tab workbook.
function exportOne(key) {
  const s = EXPORT_SHEETS[key];
  if (!s) return;
  downloadXlsx(stamp() + '_' + key + '.xlsx', [{ name: s.title, rows: s.build() }]);
}

// In-app preview: one closed accordion per report, each with its own export.
function renderExportPreview() {
  const el = $('#exportPreview');
  if (!el) return;
  if (!Object.keys(state.inventory).length) { el.innerHTML = ''; return; }
  const tbl = (rows) => {
    if (rows.length < 2) return '<p class="muted small">אין נתונים.</p>';
    // barcode column links to the wig card (the document-level [data-wig] handler)
    const bcCol = /barcode|ברקוד/i.test(String(rows[0][0] || '')) ? 0 : -1;
    const head = rows[0].map(h => `<th>${esc(h)}</th>`).join('');
    const body = rows.slice(1, 401).map(r => '<tr>' + r.map((c, i) =>
      `<td>${i === bcCol && c !== '' ? `<b class="bc-link" data-wig="${esc(c)}">${esc(c)}</b>` : esc(c)}</td>`).join('') + '</tr>').join('');
    const more = rows.length > 401 ? `<p class="muted small">מוצגות 400 מתוך ${(rows.length - 1).toLocaleString()}.</p>` : '';
    return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
  };
  el.innerHTML = EXPORT_ORDER.map(key => {
    const s = EXPORT_SHEETS[key];
    const rows = s.build();
    const body = `<button class="btn secondary small-btn cat-export" data-export-cat="${key}">${ic('download')} ייצוא קטגוריה זו</button>` + tbl(rows);
    return accCard(ic(s.icon) + ' ' + s.title, (rows.length - 1).toLocaleString(), '', body, false);
  }).join('');
}

/* Merge another device's raw-scans CSV into this one (for multi-worker counts). */
function mergeScans(text) {
  const rows = parseCSV(text);
  let merged = 0;
  const hasHeader = rows.length && isNaN(Number((rows[0][0] || '').trim()));
  const data = hasHeader ? rows.slice(1) : rows;
  for (const r of data) {
    const bc = normBarcode(r[0] || '');
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
// JSON headers for POSTs, plus the shared secret if one is configured.
function cloudHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (state.apiKey) h['x-api-key'] = state.apiKey;
  return h;
}
// fetch with a hard timeout. Without it, a hung request (flaky mobile network)
// never resolves, so pushCloud's `syncing` flag stays stuck true — and because a
// PWA doesn't reload its JS when you leave and return, every later sync attempt
// bails and the "ממתינות" counter freezes until a full reload. The abort turns a
// hang into a normal failure that the retry loop recovers from.
function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  return fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }))
    .finally(() => clearTimeout(t));
}
function deviceId() { return (state.session && state.session.trim()) || state.deviceId; }

/* ---------- Shared settings sync ----------
 * Rule: only the per-device station name (state.session) and the connection/
 * identity fields (cloudUrl / apiKey / countId) stay on the device. Everything
 * else — look (accent/dark/sound/logo), landing tab, and per-wig data
 * (names / status overrides / status vocabulary) — lives on the server keyed by
 * count_id, so every station shares one look and one data set. Last-write-wins
 * by timestamp. */
const SERVER_SETTINGS_KEYS = [
  'accent', 'dark', 'sound', 'logoAnim', 'defaultTab', 'batchMode',
  'names', 'statusOverrides', 'statusMeta', 'statusVocab'
];
function collectSettings() {
  const o = {};
  for (const k of SERVER_SETTINGS_KEYS) o[k] = state[k];
  return o;
}
let _settingsSig = '', _settingsTimer = null;
// Adopt the current settings as the baseline (so we don't echo them back).
function seedSettingsSig() { _settingsSig = JSON.stringify(collectSettings()); }
// Push to the cloud only when a *settings* field actually changed — save() runs
// on every scan too, and those must not trigger a settings write.
function scheduleSettingsPush() {
  if (!cloudEnabled()) return;
  const sig = JSON.stringify(collectSettings());
  if (sig === _settingsSig) return;
  _settingsSig = sig;
  clearTimeout(_settingsTimer);
  _settingsTimer = setTimeout(pushSettings, 900);
}
async function pushSettings() {
  if (!cloudEnabled()) return;
  try {
    const res = await fetch(cloudBase() + '/api/config', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, settings: collectSettings() })
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.settings_at) { state.lastSettingsAt = j.settings_at; save(); }  // our own write — don't re-pull it
  } catch (e) { /* a later change (or config apply) retries */ }
}
// Apply settings pulled from the cloud, last-write-wins, then refresh the UI.
function applyRemoteSettings(settings, at) {
  if (!settings || typeof settings !== 'object') return;
  at = at || 0;
  if (at <= (state.lastSettingsAt || 0)) return;   // not newer than what we already have
  for (const k of SERVER_SETTINGS_KEYS) if (k in settings) state[k] = settings[k];
  state.lastSettingsAt = at;
  // A station that hasn't migrated yet can serve back the old duplicate
  // vocabulary — re-clean it here and push the fix so the server heals too.
  const healed = migrateStatusVocab();
  seedSettingsSig();                               // adopt as baseline (no echo back)
  save();
  if (healed) pushSettings();                      // propagate the cleaned vocabulary to the server
  applyTheme(); applyLogoAnim();
  renderTheme(); renderStatusManager();
  reconcile(); renderReport(true); renderScanStats();
}

let syncTimer = null, retryTimer = null, syncing = false, pollTimer = null, syncStartedAt = 0;

function schedulePush() {
  if (!cloudEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushCloud, 700);
}

async function pushCloud() {
  if (!cloudEnabled()) return;
  // Watchdog: never let a stuck in-flight flag block sync forever. The fetch
  // timeout should always clear `syncing`, but if anything slips through, an
  // attempt older than 15s is treated as dead and overridden.
  if (syncing) { if (Date.now() - syncStartedAt < 15000) return; syncing = false; }
  const barcodes = Object.keys(state.dirty);
  if (!barcodes.length) return;
  syncing = true; syncStartedAt = Date.now();
  setCloudStatus('syncing');
  const scans = {};
  barcodes.forEach(b => { if (state.scans[b]) scans[b] = state.scans[b].count; });
  try {
    const res = await fetchT(cloudBase() + '/api/sync', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, device: deviceId(), scans })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    barcodes.forEach(b => delete state.dirty[b]);   // only clear what we sent
    save();
    renderPending();   // reflect the drained queue — else the badge stays stuck on the old count
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

// Tapping the "ממתינות" chip forces an immediate sync and — unlike the silent
// background retry — tells the user exactly why it's stuck (no server, can't
// reach it, auth, timeout), so a frozen counter is diagnosable and clearable.
async function forceSync() {
  if (!cloudEnabled()) { uiAlert('לא מוגדר סנכרון ענן. הזן כתובת שרת ושם ספירה בהגדרות → סנכרון ענן.'); return; }
  syncing = false; clearTimeout(retryTimer);            // clear any stuck in-flight state
  const pend = Object.keys(state.dirty).length;
  if (!pend) { renderPending(); pullCloud(); uiAlert('הכל מסונכרן ✓', { title: 'סנכרון' }); return; }
  setCloudStatus('syncing');
  const scans = {};
  Object.keys(state.dirty).forEach(b => { if (state.scans[b]) scans[b] = state.scans[b].count; });
  try {
    const res = await fetchT(cloudBase() + '/api/sync', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, device: deviceId(), scans })
    });
    if (!res.ok) throw new Error('השרת ענה ' + res.status + (res.status === 401 ? ' — מפתח גישה שגוי' : ''));
    Object.keys(scans).forEach(b => delete state.dirty[b]);
    Object.keys(state.dirty).forEach(b => { if (!state.scans[b]) delete state.dirty[b]; });  // drop orphans
    save(); renderPending(); renderScanStats();
    pullCloud();
    uiAlert(pend + ' סריקות סונכרנו ✓', { title: 'סנכרון' });
  } catch (e) {
    setCloudStatus('offline');
    const msg = /abort/i.test(e.message) ? 'הבקשה נתקעה (רשת איטית) — נסה שוב' :
                /fetch|network|Failed/i.test(e.message) ? 'לא הצלחתי להגיע לשרת — בדוק אינטרנט וכתובת שרת (הגדרות → בדוק חיבור)' : e.message;
    uiAlert('הסנכרון נכשל: ' + msg + '\n\nהסריקות שמורות במכשיר וינסו שוב אוטומטית.', { danger: true, title: 'סנכרון' });
  }
}

async function pullCloud() {
  if (!cloudEnabled()) return;
  try {
    const res = await fetchT(cloudBase() + '/api/scans?count_id=' + encodeURIComponent(state.countId));
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
    renderReport(); renderScanStats(); renderPending();
    setCloudStatus('ok', data);
    // heartbeat our name claim + refresh block state (throttled inside claimName)
    if (hasStation()) claimName(false);
    // adopt shared settings (look + per-wig data) set on any station
    applyRemoteSettings(data.settings, data.settings_at || 0);
    // adopt the shared inventory source set by the manager (loads it on every station)
    if (data.sheet_url && data.sheet_url !== state.sheetUrl) {
      state.sheetUrl = data.sheet_url;
      const el = $('#sheetUrl'); if (el) el.value = state.sheetUrl;
      save();
      loadFromSheet(false);
    }
    // adopt the write-back target too, so a device that lost it (cleared storage,
    // new browser) gets it back from the server instead of silently not writing.
    if (data.script_url && data.script_url !== state.writeUrl) {
      state.writeUrl = data.script_url;
      const el = $('#writeUrl'); if (el) el.value = state.writeUrl;
      save();
    }
  } catch (e) { /* keep last known cloud data */ }
}

function markAllDirty() { Object.keys(state.scans).forEach(b => { state.dirty[b] = true; }); }

// Delete/correct a single barcode's scans across the whole count.
async function deleteScan(barcode) {
  barcode = String(barcode);
  if (!(await uiConfirm('למחוק את הסריקה של ' + barcode + '?\n(מכל העמדות בספירה)', { danger: true, confirmText: 'מחק' }))) return;
  delete state.scans[barcode];
  delete state.dirty[barcode];
  if (state.cloudScans) delete state.cloudScans[barcode];
  if (state.cloudDetail) delete state.cloudDetail[barcode];
  state.sessionLog = state.sessionLog.filter(e => e.code !== barcode);
  save(); renderReport(); renderScanStats(); renderPending(); renderSessionLog();
  if (cloudEnabled()) {
    try {
      const r = await fetch(cloudBase() + '/api/delete-scan', {
        method: 'POST', headers: cloudHeaders(),
        body: JSON.stringify({ count_id: state.countId, barcode })
      });
      const j = await r.json().catch(() => ({}));
      if (j.reset_at) { state.lastResetSeen = j.reset_at; save(); }   // don't self-wipe on the resync it triggers
    } catch (e) { uiAlert('נמחק מקומית, אך הענן לא עודכן: ' + e.message); }
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
    ok: ['ok', ic('cloud') + ' מסונכרן'],
    syncing: ['dup', ic('refresh') + ' מסנכרן…'],
    offline: ['warn', ic('cloudOff') + ' אין חיבור — יסונכרן אוטומטית כשתחזור רשת']
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
    // First pull adopts the server's shared settings if they're newer; if this
    // station has never synced settings, seed the server from its current ones.
    pullCloud().then(() => { if (!state.lastSettingsAt) pushSettings(); });
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
    txt.textContent = 'התקן את האפליקציה למסך הבית';
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
  if (hasStation()) { chip.innerHTML = ic('user') + ' ' + esc(state.session.trim()); chip.classList.remove('warn'); }
  else { chip.innerHTML = ic('alert') + ' הגדר עמדה'; chip.classList.add('warn'); }
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
  if (name !== 'report') closeLookupScan();           // free the lookup camera when leaving the report
  if (name === 'report') { renderReport(); if (cloudEnabled()) pullCloud(); }   // refresh across stations
  if (name === 'export') renderExportPreview();
  if (name === 'settings') { applyAdminGate(); renderResetHistory(); renderUsers(); }   // admin-only sections
  if (name === 'scan') {
    // require a station name first; start camera within the tap so iOS allows it
    if (applyStationGate()) { setTimeout(() => $('#stationGateInput').focus(), 60); }
    else ensureCamera();
  }
}

function init() {
  load();
  applyTheme();

  // opening logo reveal — plays on every launch; header logo replays it and
  // animates continuously (its motion is toggleable in Settings). Wire + play
  // early so it dismisses even if later setup throws.
  applyLogoAnim();
  const splash = $('#splash');
  if (splash) splash.addEventListener('click', dismissSplash);
  const hdrLogo = $('#hdrLogo');
  if (hdrLogo) hdrLogo.addEventListener('click', playSplash);
  playSplash();

  // paint all static [data-ic] placeholders from the one icon set
  $$('[data-ic]').forEach(el => { el.innerHTML = ic(el.getAttribute('data-ic')); });

  // session / station name (now lives in Settings; mandatory before scanning).
  // Typing updates locally; committing (blur) claims the unique name on the
  // server and reacts to taken/blocked.
  const sess = $('#sessionName');
  sess.value = state.session || '';
  sess.addEventListener('input', () => { state.session = sess.value; save(); setCloudStatus(); updateStationChip(); });
  sess.addEventListener('change', () => onNameCommitted(sess.value, sess));
  updateStationChip();
  $('#stationChip').addEventListener('click', () => navigate('settings'));

  // mandatory-station gate on the scan tab
  $('#stationGateSave').addEventListener('click', async () => {
    const v = $('#stationGateInput').value.trim();
    if (!v) { $('#stationGateInput').focus(); return; }
    await onNameCommitted(v, sess);
    if (!hasStation()) { $('#stationGateInput').value = ''; $('#stationGateInput').focus(); return; }  // name was taken → stay on gate
    $('#stationGateInput').value = state.session;
    applyStationGate();
    if (!stationClaim.blocked) ensureCamera();
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
    const apiKeyEl = $('#apiKey');
    if (apiKeyEl) {
      apiKeyEl.value = state.apiKey || '';
      apiKeyEl.addEventListener('change', () => { state.apiKey = apiKeyEl.value.trim(); save(); });
    }
    $('#cloudTest').addEventListener('click', async () => {
      if (!state.cloudUrl) { uiAlert('הזיני קודם כתובת שרת'); return; }
      try {
        const r = await fetch(cloudBase() + '/api/health');
        uiAlert(r.ok ? 'החיבור תקין ✓' : 'השרת ענה עם שגיאה ' + r.status, { title: r.ok ? 'בדיקת חיבור' : undefined, danger: !r.ok });
      } catch (e) { uiAlert('לא הצלחתי להתחבר: ' + e.message, { danger: true }); }
    });
    $('#cloudPull').addEventListener('click', () => { if (cloudEnabled()) pullCloud(); else uiAlert('הגדירי כתובת שרת ושם ספירה'); });

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

  // Free the camera whenever the app leaves the foreground (switching to another
  // app / the phone's camera / another tab), so it never stays busy. Resume it
  // when we come back, if we're still on the scan tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (cameraOn) { cameraResumeOnVisible = true; stopCamera(); }
      closeLookupScan();   // never keep the lookup camera busy in the background
    } else {
      onForeground();      // a resumed PWA re-pulls the sheet/cloud so numbers aren't stale
      if (cameraResumeOnVisible) {
        cameraResumeOnVisible = false;
        if (document.querySelector('#panel-scan.active')) ensureCamera();
      }
    }
  });
  // bfcache restore (back/forward, some PWA resumes) doesn't re-run init — refresh here too
  window.addEventListener('pageshow', onForeground);
  window.addEventListener('pagehide', () => { if (cameraOn) stopCamera(); closeLookupScan(); });
  // Desktop: switching to another window or app fires window 'blur' but usually
  // NOT 'visibilitychange' (the tab is still "visible"), so the camera would stay
  // busy. Release it on blur too, and resume on focus if we're back on the scan
  // tab — mirroring the mobile background behaviour.
  window.addEventListener('blur', () => {
    if (cameraOn) { cameraResumeOnVisible = true; stopCamera(); }
    closeLookupScan();
  });
  window.addEventListener('focus', () => {
    onForeground();
    if (cameraResumeOnVisible && !document.hidden) {
      cameraResumeOnVisible = false;
      if (document.querySelector('#panel-scan.active')) ensureCamera();
    }
  });

  // tabs (each switch pushes history so the back button walks tabs, not out of the app)
  $$('nav button').forEach(b => b.addEventListener('click', () => navigate(b.id.replace('tab-', ''))));
  // long-press the scan tab → pick a status to stamp on every scan (scan-to-status mode)
  attachLongPress($('#tab-scan'), openScanStatusPicker);
  renderScanModeBar();
  window.addEventListener('popstate', (e) => {
    const st = e.state || { tab: 'scan' };
    showTab(st.tab || 'scan');
  });

  // accordions (settings + report) — tap header to expand/collapse
  document.addEventListener('click', (e) => {
    const head = e.target.closest('.acc-head');
    if (head && head.parentElement && head.parentElement.classList.contains('acc')) {
      head.parentElement.classList.toggle('open');
      return;
    }
    // delete-scan buttons (event delegation — no inline onclick)
    const del = e.target.closest('[data-del-code]');
    if (del) { deleteScan(del.getAttribute('data-del-code')); return; }
    // per-item quick undo in the batch list
    const bu = e.target.closest('[data-undo-code]');
    if (bu) { unrecordScan(bu.getAttribute('data-undo-code')); return; }
    // tap a barcode → open its wig product card
    const wig = e.target.closest('[data-wig]');
    if (wig) { e.stopPropagation(); openProductCard(wig.getAttribute('data-wig')); return; }
    // per-category export button
    const exp = e.target.closest('[data-export-cat]');
    if (exp) { e.stopPropagation(); exportOne(exp.getAttribute('data-export-cat')); return; }
    // report refresh button
    if (e.target.closest('[data-report-refresh]')) { if (cloudEnabled()) pullCloud(); renderReport(); return; }
    // clickable dashboard stat → open + scroll to its category
    const stat = e.target.closest('[data-jump]');
    if (stat) {
      const target = document.getElementById(stat.getAttribute('data-jump'));
      const acc = target && target.querySelector('.acc');
      if (acc) {
        acc.classList.add('open');
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
  // keyboard access for the clickable stats
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-jump]')) {
      e.preventDefault(); e.target.click();
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
  const goSheet = $('#goSheetSettings');
  if (goSheet) goSheet.addEventListener('click', openSheetSettings);

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
  $('#clearInv').addEventListener('click', async () => {
    if (await uiConfirm('למחוק את המלאי שנטען?', { danger: true, confirmText: 'מחק' })) {
      state.inventory = {}; state.invNames = {}; save(); renderInventoryStatus(); renderReport(true);
    }
  });

  // install to home screen
  setupInstall();

  // scanning
  setupScanInput();
  $('#cameraBtn').addEventListener('click', startCamera);
  $('#camStart').addEventListener('click', startCamera);   // tap-to-start (required on iOS)
  $('#flashBtn').addEventListener('click', toggleTorch);

  // reset scans (moved to Settings → איפוס ושחזור). History loads lazily when
  // the Settings tab opens (see showTab), so no network call on every launch.
  const resetSettingsBtn = $('#resetScansSettings');
  if (resetSettingsBtn) resetSettingsBtn.addEventListener('click', doResetScans);

  // undo / redo / batch mode
  const undoBtn = $('#undoBtn'), redoBtn = $('#redoBtn'), batchBtn = $('#batchBtn');
  if (undoBtn) undoBtn.addEventListener('click', undoScan);
  if (redoBtn) redoBtn.addEventListener('click', redoScan);
  if (batchBtn) batchBtn.addEventListener('click', () => {
    state.batchMode = !state.batchMode; save();
    batchBtn.classList.toggle('active', state.batchMode);
    renderSessionLog();
  });
  if (batchBtn) batchBtn.classList.toggle('active', state.batchMode);
  const batchClear = $('#batchClear');
  if (batchClear) batchClear.addEventListener('click', () => { state.sessionLog = []; save(); renderSessionLog(); });
  updateUndoRedo();

  // lookup-scan overlay (report tab): close button + tap-outside to dismiss
  const scanOverlay = $('#scanOverlay');
  if (scanOverlay) {
    const closeBtn = $('#scanOverlayClose');
    if (closeBtn) closeBtn.addEventListener('click', closeLookupScan);
    scanOverlay.addEventListener('click', (e) => { if (e.target === scanOverlay) closeLookupScan(); });
  }

  // wig product card modal: close button + tap-outside to dismiss
  const productModal = $('#productModal');
  if (productModal) {
    const pc = $('#productClose');
    if (pc) pc.addEventListener('click', closeProductCard);
    productModal.addEventListener('click', (e) => { if (e.target === productModal) closeProductCard(); });
  }

  // export
  const expExcel = $('#expExcel');
  if (expExcel) expExcel.addEventListener('click', exportExcel);
  const mergeFile = $('#mergeFile');
  if (mergeFile) mergeFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const n = mergeScans(reader.result); renderExportPreview(); uiAlert('מוזגו ' + n + ' סריקות.', { title: 'מיזוג הושלם' }); };
    reader.readAsText(file, 'UTF-8');
  });

  // appearance / brand theme
  setupTheme();

  renderVersions();
  renderInventoryStatus();
  renderScanStats();
  renderReport();
  renderPending();
  renderSessionLog();

  // access control: show sensitive settings only to admins; claim our name on
  // the server (uniqueness + block state) and heartbeat from there on.
  applyAdminGate();
  if (cloudEnabled() && hasStation()) claimName(true).then(() => renderUsers());

  // landing view — the tab chosen in Settings (default: scan); seed history so back walks tabs
  const start = defaultTab();
  history.replaceState({ tab: start }, '');
  showTab(start);
}

/* ---------- Opening logo reveal (splash) ----------
 * The full-screen reveal plays on every app open and whenever the header logo
 * is tapped. The small header logo also animates continuously; that constant
 * motion (only) can be turned off in Settings via state.logoAnim — the splash
 * itself always plays. */
const SPLASH_SPARK =
  '<svg viewBox="0 0 100 100"><defs><radialGradient id="spg" cx="50%" cy="50%" r="50%">' +
  '<stop offset="0%" stop-color="#fffbe9"/><stop offset="55%" stop-color="#f4d9a6"/>' +
  '<stop offset="100%" stop-color="#e7c99b" stop-opacity="0"/></radialGradient></defs>' +
  '<path d="M50 4 C54 34 66 46 96 50 C66 54 54 66 50 96 C46 66 34 54 4 50 C34 46 46 34 50 4 Z" fill="url(#spg)"/>' +
  '<circle cx="50" cy="50" r="6" fill="#fffdf5"/></svg>';
let splashTimer = null;
function playSplash() {
  const sp = $('#splash'); if (!sp) return;
  sp.querySelectorAll('.sp-spark').forEach(s => { if (!s.innerHTML) s.innerHTML = SPLASH_SPARK; });
  clearTimeout(splashTimer);
  sp.classList.remove('hidden', 'done', 'run');
  void sp.offsetWidth;                 // reflow so the CSS animations restart on replay
  sp.classList.add('run');
  splashTimer = setTimeout(dismissSplash, 2700);
}
function dismissSplash() {
  const sp = $('#splash'); if (!sp) return;
  clearTimeout(splashTimer);
  sp.classList.add('done');
  setTimeout(() => { sp.classList.add('hidden'); sp.classList.remove('run'); }, 520);
}
function applyLogoAnim() {
  const el = $('#hdrLogo'); if (el) el.classList.toggle('no-anim', state.logoAnim === false);
}

// Appearance settings: accent swatches (global) + dark toggle + scan sound + logo motion.
function setupTheme() {
  renderTheme();
  renderSound();
  renderStatusManager();
  const darkEl = $('#darkToggle');
  if (darkEl) {
    darkEl.checked = !!state.dark;
    darkEl.addEventListener('change', () => { state.dark = darkEl.checked; save(); applyTheme(); });
  }
  const logoEl = $('#logoAnimToggle');
  if (logoEl) {
    logoEl.checked = state.logoAnim !== false;
    logoEl.addEventListener('change', () => { state.logoAnim = logoEl.checked; save(); applyLogoAnim(); });
  }
  renderDefaultTab();
  renderUnknownAlert();
}
function renderDefaultTab() {
  const wrap = $('#defaultTabPicker');
  if (!wrap) return;
  const cur = defaultTab();
  wrap.innerHTML = TABS.map(t =>
    `<button class="seg-opt${t.id === cur ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('');
  wrap.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    state.defaultTab = b.getAttribute('data-tab'); save(); renderDefaultTab();
  }));
}

/* ---------- Status manager (Settings) ----------
 * Lets the manager rename each status (the Hebrew label shown everywhere) and
 * toggle whether it counts as "in the store" (inventory). New statuses can be
 * added; sheet-imported ones appear here automatically. */
function renderStatusManager() {
  const el = $('#statusManager');
  if (!el) return;
  const v = statusVocab();
  const rows = v.map(s => `
    <div class="st-row" data-st-key="${esc(s.key)}">
      <input class="st-label" data-st-label value="${esc(s.label)}" maxlength="24" autocomplete="off" aria-label="שם הסטטוס">
      <label class="st-toggle"><input type="checkbox" data-st-instore${s.inStore ? ' checked' : ''}><span>בחנות</span></label>
      <button class="icon-btn danger st-del" title="מחק סטטוס">${ic('trash')}</button>
    </div>`).join('');
  el.innerHTML = `
    <p class="muted small">כל פאה מקבלת סטטוס. סמני אילו סטטוסים נחשבים "בחנות" (נספרים במלאי). השם הוא מה שמוצג באפליקציה.</p>
    <div class="st-list">${rows}</div>
    <div class="st-add">
      <input id="stNewLabel" placeholder="שם סטטוס חדש" maxlength="24" autocomplete="off">
      <button class="btn secondary small-btn" id="stAdd">${ic('check')} הוסף</button>
    </div>
    <button class="btn ghost small-btn" id="stReset" style="margin-top:12px">${ic('reset')} אפס לרשימת ברירת המחדל</button>`;

  const afterEdit = () => { save(); renderReport(true); renderScanStats(); renderInventoryStatus(); };

  el.querySelectorAll('.st-row').forEach(row => {
    const key = row.getAttribute('data-st-key');
    const labelEl = row.querySelector('[data-st-label]');
    const inStoreEl = row.querySelector('[data-st-instore]');
    const delEl = row.querySelector('.st-del');
    if (labelEl) labelEl.addEventListener('change', () => {
      const v2 = ensureVocabCopy(); const t = v2.find(s => s.key === key);
      if (t) { t.label = labelEl.value.trim() || key; afterEdit(); }
    });
    if (inStoreEl) inStoreEl.addEventListener('change', () => {
      const v2 = ensureVocabCopy(); const t = v2.find(s => s.key === key);
      if (t) { t.inStore = inStoreEl.checked; afterEdit(); }
    });
    if (delEl) delEl.addEventListener('click', async () => {
      // Every status is deletable now — but warn before removing one that drives
      // the inventory count or that wigs are currently using.
      const meta = statusMeta(key);
      const inv = effInv();
      let inUse = 0; for (const bc in inv) if (inv[bc] === key) inUse++;
      const parts = [];
      if (meta && meta.inStore) parts.push('הסטטוס הזה מסומן "בחנות" ונספר במלאי — מחיקתו תגרום לפאות עם הסטטוס הזה להפסיק להיספר במלאי.');
      if (inUse) parts.push(inUse + ' פאות משתמשות בסטטוס הזה כרגע. הן לא יימחקו, אבל יאבדו את השם המוצג.');
      if (parts.length) {
        const ok = await uiConfirm(parts.join('\n\n') + '\n\nלמחוק את הסטטוס?',
          { title: 'מחיקת סטטוס', danger: true, confirmText: 'מחק' });
        if (!ok) return;
      }
      const v2 = ensureVocabCopy(); const i = v2.findIndex(s => s.key === key);
      if (i >= 0) { v2.splice(i, 1); afterEdit(); renderStatusManager(); }
    });
  });

  const addBtn = $('#stAdd'), newEl = $('#stNewLabel');
  const doAdd = () => {
    const label = (newEl.value || '').trim();
    if (!label) { newEl.focus(); return; }
    const v2 = ensureVocabCopy();
    // a stable, collision-free key derived from the label (or a fallback)
    let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'status';
    let key = base, n = 2;
    while (v2.some(s => s.key === key)) key = base + '-' + (n++);
    v2.push({ key, label, inStore: false });
    newEl.value = '';
    afterEdit(); renderStatusManager();
  };
  if (addBtn) addBtn.addEventListener('click', doAdd);
  if (newEl) newEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

  const resetBtn = $('#stReset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    if (!(await uiConfirm('לאפס את רשימת הסטטוסים לברירת המחדל? (התוויות והסימונים המותאמים יימחקו)', { danger: true, confirmText: 'אפס' }))) return;
    state.statusVocab = null; save();
    renderStatusManager(); renderReport(true); renderScanStats(); renderInventoryStatus();
  });
}
/* ---------- Scan reset + restore (Settings → איפוס ושחזור) ----------
 * Reset wipes every scan of the current count across ALL stations (via
 * /api/reset). It's destructive, so the SERVER snapshots the merged totals into
 * a shared `backups` table BEFORE wiping — recording WHO reset, WHEN and HOW
 * MUCH. Because the backup lives on the server (not the device that clicked
 * reset), ANY station can list it (/api/backups) and restore it (/api/restore),
 * even if the resetting phone is gone. Restore rewrites the cloud counts and
 * bumps reset_at so every station converges on the restored snapshot. */
function fmtResetTime(ts) {
  try { return new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }); }
  catch (e) { return new Date(ts).toLocaleString(); }
}
function resetByName() { return (state.session || '').trim() || (state.deviceId || 'לא ידוע'); }

async function doResetScans() {
  const merged = effectiveScans();
  const bcs = Object.keys(merged);
  const totalCount = bcs.reduce((s, k) => s + (merged[k] ? merged[k].count || 0 : 0), 0);

  if (!cloudEnabled()) {
    // No shared server → no central backup. Warn clearly before allowing it.
    const go = await uiConfirm(
      'סנכרון הענן כבוי, ולכן לא ניתן לשמור גיבוי מרכזי לשחזור.\n\n' +
      'איפוס עכשיו ימחק את הסריקות ללא אפשרות שחזור. מומלץ להפעיל סנכרון ענן (הגדרות → סנכרון ענן) לפני איפוס.\n\n' +
      'לאפס בכל זאת, בלי גיבוי?',
      { title: 'אזהרה — אין גיבוי', danger: true, confirmText: 'אפס בלי גיבוי', cancelText: 'ביטול' }
    );
    if (!go) return;
    state.scans = {}; state.dirty = {}; state.cloudScans = {}; state.sessionLog = [];
    undoStack.length = 0; redoStack.length = 0; updateUndoRedo();
    save();
    renderReport(true); renderScanStats(); renderPending(); renderSessionLog();
    const sb0 = $('#scanBanner');
    if (sb0) { sb0.className = 'scan-banner'; sb0.innerHTML = '<div class="msg muted">מוכן לסריקה…</div>'; }
    return;
  }

  const ok = await uiConfirm(
    'האם את בטוחה שברצונך לאפס את כל הסריקות?\n\n' +
    'הפעולה מוחקת את כל ' + totalCount.toLocaleString() + ' הסריקות של הספירה — בכל העמדות. ' +
    'לא ניתן לסרוק אותן חזרה אוטומטית. המלאי, השמות והסטטוסים יישארו.\n\n' +
    'לפני האיפוס יישמר גיבוי בשרת (עם השם "' + resetByName() + '"), ותוכלי לשחזר ממנו מכל עמדה, בכל רגע.',
    { title: 'אזהרה — איפוס סריקות', danger: true, confirmText: 'כן, אפס הכל', cancelText: 'ביטול' }
  );
  if (!ok) return;

  // Server snapshots to `backups` before wiping. Send who is resetting.
  let backupId = null;
  try {
    const rr = await fetch(cloudBase() + '/api/reset', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, by: normName(state.session), device_id: state.deviceId })
    });
    const rj = await rr.json().catch(() => ({}));
    if (!rr.ok) throw new Error(rj.error || ('השרת ענה ' + rr.status));
    backupId = rj.backup_id || null;
    if (rj.reset_at) state.lastResetSeen = rj.reset_at;   // don't re-trigger on our own reset
  } catch (e) {
    uiAlert('האיפוס לא בוצע — לא הצלחתי להגיע לשרת: ' + e.message + '\nהסריקות נשמרו כפי שהן.', { danger: true, title: 'האיפוס נכשל' });
    return;   // keep local scans intact if the server (and therefore the backup) failed
  }

  // Server wiped + backed up. Now clear locally to match.
  state.scans = {}; state.dirty = {}; state.cloudScans = {}; state.sessionLog = [];
  undoStack.length = 0; redoStack.length = 0; updateUndoRedo();
  save();
  renderReport(true); renderScanStats(); renderPending(); renderSessionLog(); renderResetHistory();
  const sb = $('#scanBanner');
  if (sb) { sb.className = 'scan-banner'; sb.innerHTML = '<div class="msg muted">מוכן לסריקה…</div>'; }
  uiAlert(backupId
    ? 'הסריקות אופסו. גיבוי נשמר בשרת תחת "היסטוריית גיבויים לשחזור" — אפשר לשחזר ממנו מכל עמדה.'
    : 'הסריקות אופסו. (לא היו סריקות לגבות.)', { title: 'האיפוס הושלם' });
}

async function restoreReset(backup) {
  const ok = await uiConfirm(
    'לשחזר את הגיבוי מ-' + fmtResetTime(backup.created_at) + ' (' + (backup.by || 'לא ידוע') + ')?\n\n' +
    (backup.total_scanned || 0).toLocaleString() + ' פאות (' + (backup.total_count || 0).toLocaleString() + ' סריקות) יוחזרו לכל העמדות. ' +
    'הסריקות הנוכחיות בספירה יוחלפו בגיבוי הזה.',
    { title: 'שחזור מגיבוי', confirmText: 'שחזר', cancelText: 'ביטול' }
  );
  if (!ok) return;

  try {
    const rr = await fetch(cloudBase() + '/api/restore', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, backup_id: backup.id, by: normName(state.session), device_id: state.deviceId })
    });
    const rj = await rr.json().catch(() => ({}));
    if (!rr.ok) throw new Error(rj.error || ('השרת ענה ' + rr.status));
    if (rj.reset_at) state.lastResetSeen = rj.reset_at;   // we already know about this generation
    // clear local then pull the restored totals the server just wrote
    state.scans = {}; state.dirty = {}; state.cloudScans = {}; state.sessionLog = [];
    undoStack.length = 0; redoStack.length = 0; updateUndoRedo();
    save();
    await pullCloud();
    renderReport(true); renderScanStats(); renderPending(); renderSessionLog();
    uiAlert('שוחזרו ' + (rj.restored || backup.total_scanned || 0).toLocaleString() +
      ' פאות מהגיבוי. הסריקות חזרו לענן ולכל העמדות.', { title: 'השחזור הושלם' });
  } catch (e) {
    uiAlert('השחזור נכשל: ' + e.message, { danger: true, title: 'שחזור' });
  }
}

async function renderResetHistory() {
  const el = $('#resetHistory');
  if (!el) return;
  if (!cloudEnabled()) {
    el.innerHTML = '<p class="muted small" style="margin:0">היסטוריית הגיבויים נשמרת בשרת וזמינה כשסנכרון הענן דלוק (הגדרות → סנכרון ענן).</p>';
    return;
  }
  el.innerHTML = '<p class="muted small" style="margin:0">טוען גיבויים…</p>';
  let backups = [];
  try {
    const res = await fetchT(cloudBase() + '/api/backups?count_id=' + encodeURIComponent(state.countId));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    backups = data.backups || [];
  } catch (e) {
    el.innerHTML = '<p class="small" style="margin:0;color:var(--bad)">לא הצלחתי לטעון גיבויים מהשרת: ' + esc(e.message) + '</p>';
    return;
  }
  if (!backups.length) {
    el.innerHTML = '<p class="muted small" style="margin:0">אין עדיין גיבויים. גיבוי נוצר אוטומטית בשרת בכל איפוס.</p>';
    return;
  }
  el.innerHTML = '<div class="rh-list">' + backups.map((b, i) => `
    <div class="rh-row" data-rh-i="${i}">
      <div class="rh-info">
        <div class="rh-main">${ic('user')} <b>${esc(b.by || 'לא ידוע')}</b> · ${esc(fmtResetTime(b.created_at))}</div>
        <div class="rh-sub muted small">${(b.total_scanned || 0).toLocaleString()} פאות · ${(b.total_count || 0).toLocaleString()} סריקות</div>
      </div>
      <div class="rh-actions">
        <button class="btn secondary small-btn rh-restore">${ic('undo')} שחזר</button>
      </div>
    </div>`).join('') + '</div>';

  el.querySelectorAll('.rh-row').forEach(row => {
    const b = backups[+row.getAttribute('data-rh-i')];
    const rb = row.querySelector('.rh-restore');
    if (rb) rb.addEventListener('click', () => restoreReset(b));
  });
}

/* ---------- Station name claim + block + user management ----------
 * Every station registers its name with the server (unique per count). The call
 * doubles as a heartbeat (keeps the claim fresh) and tells us if the admin has
 * blocked us. Admins additionally get the user-management UI below. */
let lastClaimAt = 0;
async function claimName(force) {
  if (!cloudEnabled() || !hasStation()) return null;
  const now = Date.now();
  if (!force && now - lastClaimAt < 45000) return stationClaim;   // heartbeat throttle
  lastClaimAt = now;
  try {
    const r = await fetch(cloudBase() + '/api/claim-name', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, name: normName(state.session), device_id: state.deviceId })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 || j.taken) stationClaim = { owner: false, blocked: false, taken: true, rank: 0 };
    else stationClaim = { owner: !!j.owner, blocked: !!j.blocked, taken: false, rank: j.rank || 0 };
  } catch (e) { /* keep last known claim state on a network blip */ }
  applyBlockGate();
  applyAdminGate();   // the server just told us our rank — reflect it in the UI
  return stationClaim;
}

// Blocked station: cover the scan tab with a lock message and stop the camera.
function applyBlockGate() {
  const gate = $('#blockGate');
  const scanner = document.querySelector('#panel-scan .scanner');
  const blocked = !!stationClaim.blocked;
  if (gate) gate.classList.toggle('hidden', !blocked);
  if (blocked) {
    if (scanner) scanner.classList.add('hidden');
    stopCamera();
  } else if (scanner && hasStation()) {
    scanner.classList.remove('hidden');
  }
  const chip = $('#stationChip');
  if (chip) chip.classList.toggle('blocked', blocked);
}

// Show/hide the sensitive settings: only admins (server-confirmed rank >= 1) see them.
function applyAdminGate() {
  const admin = isAdmin();
  document.querySelectorAll('[data-admin-only]').forEach(el => el.classList.toggle('hidden', !admin));
}

// When the station name is committed (blur / gate save): normalize, claim it,
// and react to "taken" / "blocked". Reverts a taken name so no two stations
// share one, and refreshes the admin gate + user list.
async function onNameCommitted(raw, el) {
  const name = normName(raw);
  state.session = name; if (el) el.value = name; save();
  updateStationChip(); setCloudStatus(); applyAdminGate();
  if (!name || !cloudEnabled()) { applyBlockGate(); return; }
  const c = await claimName(true);
  if (c && c.taken) {
    await uiAlert('השם "' + name + '" כבר בשימוש בעמדה אחרת. בחרי שם אחר.', { danger: true, title: 'שם תפוס' });
    state.session = ''; if (el) el.value = '';
    const sess = $('#sessionName'); if (sess) sess.value = '';
    save(); updateStationChip(); setCloudStatus(); applyAdminGate(); applyStationGate();
    stationClaim = { owner: false, blocked: false, taken: true };
    return;
  }
  applyAdminGate();
  renderUsers();
  if (c && c.blocked) uiAlert('לא ניתן לסרוק מהעמדה הזו כרגע. פני למפתח.', { title: 'העמדה אינה זמינה' });
}

// Admin: list all stations/users with block / rename / delete controls.
async function renderUsers() {
  const el = $('#usersManager');
  if (!el) return;
  if (!isAdmin() || !cloudEnabled()) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="muted small" style="margin:0">טוען משתמשים…</p>';
  let data;
  try {
    const r = await fetchT(cloudBase() + '/api/stations?count_id=' + encodeURIComponent(state.countId) +
      '&by=' + encodeURIComponent(normName(state.session)) + '&device_id=' + encodeURIComponent(state.deviceId));
    data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  } catch (e) {
    el.innerHTML = '<p class="small" style="margin:0;color:var(--bad)">לא הצלחתי לטעון משתמשים: ' + esc(e.message) + '</p>';
    return;
  }
  const myRank = data.actor_rank || stationClaim.rank || 0;
  const list = data.stations || [];
  const rows = list.map((s, i) => {
    const canManage = myRank > s.rank;
    const role = s.rank >= 2 ? '<span class="u-role super">מנהל־על</span>'
               : s.rank >= 1 ? '<span class="u-role admin">מנהלת</span>' : '';
    const actions = canManage ? `
        <button class="icon-btn u-block" title="${s.blocked ? 'בטל חסימה' : 'חסום'}">${ic(s.blocked ? 'check' : 'alert')}</button>
        <button class="icon-btn u-rename" title="שנה שם">${ic('edit')}</button>
        <button class="icon-btn danger u-del" title="מחק">${ic('trash')}</button>`
      : '<span class="muted small">—</span>';
    return `<div class="u-row" data-u-i="${i}">
      <div class="u-info">
        <div class="u-main"><span class="u-dot${s.online ? ' on' : ''}"></span><b>${esc(s.name)}</b>${role}${s.is_you ? ' <span class="u-you">(את/ה)</span>' : ''}${s.blocked ? ' <span class="u-blocked">חסום</span>' : ''}</div>
        <div class="u-sub muted small">${(s.scans || 0).toLocaleString()} סריקות</div>
      </div>
      <div class="u-actions">${actions}</div>
    </div>`;
  }).join('');
  el.innerHTML =
    `<p class="muted small">כל העמדות בספירה. חסימה מונעת סריקה. ${myRank >= 2 ? '' : 'אינך יכולה לנהל מנהלים בדרגה שווה או גבוהה.'}</p>` +
    `<div class="u-list">${rows || '<p class="muted small">אין עדיין עמדות.</p>'}</div>`;

  el.querySelectorAll('.u-row').forEach(row => {
    const s = list[+row.getAttribute('data-u-i')];
    const bl = row.querySelector('.u-block'), rn = row.querySelector('.u-rename'), dl = row.querySelector('.u-del');
    if (bl) bl.addEventListener('click', () => userAction(s.blocked ? 'unblock' : 'block', s.name));
    if (rn) rn.addEventListener('click', async () => {
      const nn = await uiPrompt('שם חדש עבור "' + s.name + '":', { title: 'שינוי שם', value: s.name, confirmText: 'שמור' });
      if (nn && normName(nn) && normName(nn) !== s.name) userAction('rename', s.name, normName(nn));
    });
    if (dl) dl.addEventListener('click', async () => {
      if (await uiConfirm('למחוק את "' + s.name + '"? הרישום יוסר והשם יתפנה לשימוש מחדש. (הסריקות שלו נשארות בספירה.)', { danger: true, title: 'מחיקת משתמש', confirmText: 'מחק' }))
        userAction('delete', s.name);
    });
  });
}

async function userAction(action, name, newName) {
  try {
    const r = await fetch(cloudBase() + '/api/stations', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, by: normName(state.session), device_id: state.deviceId, action, name, new_name: newName })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('השרת ענה ' + r.status));
    renderUsers();
    if (cloudEnabled()) pullCloud();
  } catch (e) { uiAlert('הפעולה נכשלה: ' + e.message, { danger: true, title: 'ניהול משתמשים' }); }
}

function renderTheme() {
  const wrap = $('#accentSwatches');
  if (!wrap) return;
  const cur = accentKey();
  wrap.innerHTML = Object.entries(ACCENTS).map(([k, a]) =>
    `<button class="swatch${k === cur ? ' active' : ''}" data-accent="${k}" title="${esc(a.name)}" style="--sw:${a.v}"><span></span></button>`
  ).join('');
  wrap.querySelectorAll('[data-accent]').forEach(b => b.addEventListener('click', () => {
    state.accent = b.getAttribute('data-accent'); save(); applyTheme(); renderTheme();
  }));
}
function renderSound() {
  const wrap = $('#soundPicker');
  if (!wrap) return;
  const cur = soundKey();
  wrap.innerHTML = Object.entries(SOUNDS).map(([k, s]) =>
    `<button class="sound-opt${k === cur ? ' active' : ''}" data-sound="${k}">${esc(s.name)}</button>`
  ).join('');
  wrap.querySelectorAll('[data-sound]').forEach(b => b.addEventListener('click', () => {
    state.sound = b.getAttribute('data-sound'); save(); renderSound(); beep('ok');   // preview
  }));
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
  if (res.error) { uiAlert(res.error, { danger: true }); return; }
  renderInventoryStatus();
  renderReport(true);
  renderScanStats();
  renderStatusManager();
  let note = `נטענו ${res.added.toLocaleString()} פאות.`;
  if (res.hasNames) note += ` (כולל ${res.hasNames.toLocaleString()} שמות)`;
  if (res.unknownStatus) note += ` — ${res.unknownStatus} סטטוסים חדשים נוספו לרשימת הסטטוסים בהגדרות`;
  $('#importNote').textContent = note;
}

// Load the inventory from a shared Google Sheet, proxied through the Worker.
// Re-sync when the app returns to the foreground (PWA resume, tab refocus,
// bfcache restore). Without this, a page frozen for hours keeps showing a
// weeks-old catalog/count until a manual refresh — the "stale numbers on open"
// bug — because loadFromSheet otherwise runs only on a full page load, and the
// background poll then re-saves that stale in-memory catalog. Throttled so
// rapid focus/blur flips don't spam the network.
let lastForegroundSync = 0;
function onForeground() {
  if (typeof document !== 'undefined' && document.hidden) return;
  const now = Date.now();
  if (now - lastForegroundSync < 4000) return;
  lastForegroundSync = now;
  if (cloudEnabled()) pullCloud();
  if (state.sheetUrl) loadFromSheet(false);
}

async function loadFromSheet(alertOnError) {
  const note = $('#sheetNote');
  const setNote = (color, txt) => { if (note) { note.style.color = color; note.textContent = txt; } };
  if (!state.sheetUrl) { if (alertOnError) uiAlert('הדביקי קישור לגיליון'); return; }
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
    renderInventoryStatus(); renderReport(true); renderScanStats(); renderStatusManager();
    setNote('var(--ok)', `נטענו ${res.added.toLocaleString()} פאות מהשיטס`);
    // share this inventory source with the whole count so other stations auto-load it
    if (alertOnError && cloudEnabled()) {
      try {
        await fetch(cloudBase() + '/api/config', {
          method: 'POST', headers: cloudHeaders(),
          body: JSON.stringify({ count_id: state.countId, sheet_url: state.sheetUrl })
        });
      } catch (e) { /* non-fatal */ }
    }
  } catch (e) {
    setNote('var(--bad)', e.message);
    if (alertOnError) uiAlert('לא הצלחתי לטעון מהשיטס: ' + e.message, { danger: true });
  }
}

// Register the Apps Script URL for the count so the cron auto-writes.
async function registerScriptUrl() {
  if (!cloudEnabled() || !state.writeUrl) return;
  try {
    await fetch(cloudBase() + '/api/config', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ count_id: state.countId, script_url: state.writeUrl })
    });
  } catch (e) { /* non-fatal */ }
}

// Editable per-wig fields (name + status change) this device knows about, to
// write into the sheet alongside the scan columns. Names come from in-app edits
// or the sheet's own name column; status only when it was changed from a card.
function writebackFields() {
  const fields = {};
  const add = (bc, k, v) => { if (v) { (fields[bc] = fields[bc] || {})[k] = v; } };
  for (const bc in state.names) add(bc, 'name', state.names[bc]);
  for (const bc in state.invNames) if (!(fields[bc] && fields[bc].name)) add(bc, 'name', state.invNames[bc]);
  for (const bc in state.statusOverrides) add(bc, 'status', statusLabel(state.statusOverrides[bc]));
  return fields;
}

// Write results back to the sheet now. The Worker pulls the authoritative
// scans (all stations) from the cloud, so it never depends on this device.
// Names/status edits are attached from this device (see writebackFields).
async function writeToSheet() {
  const note = $('#writeNote');
  const setNote = (c, t) => { if (note) { note.style.color = c; note.textContent = t; } };
  if (!state.writeUrl) { setNote('var(--bad)', 'הדביקי קישור Apps Script'); return; }
  if (!state.cloudUrl) { setNote('var(--bad)', 'צריך כתובת שרת (ענן).'); return; }
  setNote('var(--ink-3)', 'כותב לשיטס…');
  try {
    await registerScriptUrl();   // also turns on auto-write from now on
    const r = await fetch(cloudBase() + '/api/writeback', {
      method: 'POST', headers: cloudHeaders(),
      body: JSON.stringify({ script_url: state.writeUrl, count_id: state.countId, fields: writebackFields() })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('שגיאה ' + r.status));
    const nm = j.names ? ` · ${j.names} שמות` : '';
    setNote('var(--ok)', `נכתב לשיטס — ${j.written} פאות (נסרק / תאריך / עמדה / שם${nm}). מכאן זה נכתב אוטומטית.`);
  } catch (e) {
    setNote('var(--bad)', e.message);
  }
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

// Expose pure logic for the Node test runner (no effect in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normBarcode, parseCSV, detectColumns, importInventory, reconcile, toCSV, colName, crc32, buildXlsx, state, isInStore, statusOf, effInv, statusLabel, wigName, KNOWN_STATUSES, DEFAULT_STATUSES, normStatusKey, migrateStatusVocab, migrateStatusData, migrateStatuses };
}
