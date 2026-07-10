# WigsStock · Handoff (למפתח/סשן הבא)

אפליקציית **ספירת מלאי פאות** עם סריקת ברקוד, סנכרון ענן בין עמדות, וקריאה/כתיבה מול Google Sheets.
המסמך הזה מסכם את כל מה שצריך כדי להמשיך. **סטטוס: פרודוקשן, גרסה 1.4.0. הכל committed + pushed.**

## קישורים
- **אפליקציה חיה:** https://ben11111stack.github.io/WigsStock-/ (GitHub Pages)
- **Repo:** `ben11111stack/WigsStock-` (public) · branch עבודה: `claude/inventory-barcode-scanner-4w4fbf`
- **Backend (Cloudflare Worker):** https://wigsstock-sync.benzi-naor.workers.dev
- **גיליון המלאי (של המשתמש):** Google Sheet id `17Sem_IwgporhMsXEhVvW7ysIamzc_Ktxv-7molhp35k` (משותף "מציג")

## ארכיטקטורה (local-first)
- **Frontend:** vanilla JS, ללא build. `index.html` + `app.js` + `styles.css` + `zxing.min.js`. PWA (manifest + `sw.js`).
  - סריקה: לולאה ידנית שמציירת פריים ל-canvas ומפענחת עם ZXing `decodeBitmap` + `TRY_HARDER` (ראה `startCamera`/`scanTick` ב-app.js). הגישה הזו נבחרה כי `decodeFromConstraints` לא פענח על מכשירים אמיתיים.
  - כל סריקה נשמרת מיד ב-`localStorage` (מפתח `wigsstock_v1`), ומסתנכרנת לענן ברקע (debounce 700ms), עם תור אופליין.
- **Cloud (Cloudflare Worker + D1):** מאחסן סריקות ומאחד בין עמדות. גם: proxy לקריאת הגיליון (עוקף CORS), וכתיבה חזרה לגיליון דרך Apps Script.
- **Sheets:** המלאי נקרא מהגיליון (proxy). התוצאות נכתבות חזרה ל-3 עמודות (נסרק/תאריך סריקה/עמדה) דרך Apps Script — לא נוגע בעמודות המקוריות.

### מודל נתונים / endpoints (Worker — `worker/src/worker.js`)
D1 טבלאות: `scans(count_id, device, barcode, count, updated_at)` (PK של השלושה הראשונים) · `meta(count_id, sheet_url, script_url, reset_at, last_written, updated_at)`.
- `GET  /api/health`
- `POST /api/sync` `{count_id, device, scans:{barcode:count}}` — upsert אבסולוטי (אידמפוטנטי). מפעיל כתיבה מהירה לשיטס (throttle 5ש') דרך `ctx.waitUntil`.
- `GET  /api/scans?count_id=` → `{scans:{bc:total}, detail:{bc:{count,last,station}}, devices, sheet_url, reset_at}`
- `POST /api/config` `{count_id, sheet_url?, script_url?}` — רושם מקור מלאי + סקריפט כתיבה (מעדכן רק שדות שנשלחו).
- `POST /api/reset` `{count_id}` — מוחק ספירה, מקדם `reset_at` (כל העמדות מנקות מקומית בסנכרון הבא).
- `POST /api/delete-scan` `{count_id, barcode}` — מוחק ברקוד אחד (גם מקדם `reset_at` → resync).
- `GET  /api/sheet?url=` — proxy: מחזיר את הגיליון כ-CSV (allowlist `docs.google.com`).
- `POST /api/writeback` `{count_id, script_url?}` — שולף aggregate מ-D1 ושולח ל-Apps Script.
- **Cron** `* * * * *` (scheduled) — כתיבה אוטומטית לשיטס לכל count עם `script_url` ושינויים חדשים.

## פריסה
- **Frontend:** push ל-branch → GitHub Actions (`.github/workflows/deploy-pages.yml`) בונה ופורס ל-Pages אוטומטית. אחרי כל שינוי קוד לקוח **במפ את `CACHE` ב-`sw.js`** (כרגע `wigsstock-v4`) כדי שבאנר "עדכן עכשיו" יופיע למשתמשים.
- **קובץ יחיד:** `node build-single.js` → `wigsstock-app.html` (הכל inline). הרץ אחרי כל שינוי frontend.
- **Worker:** מתוך `worker/` —
  ```bash
  export CLOUDFLARE_API_TOKEN=<token מהמשתמש>
  export CLOUDFLARE_ACCOUNT_ID=7c5259865ad06b1a05dbff3e55d53027
  npx wrangler@3 deploy
  ```
  D1 database: `wigsstock` (id `25c4cb65-108a-4295-8090-5c2dc9c787ec`, כבר ב-`wrangler.toml`).

## ⚠️ סוד/הרשאות שצריך מהמשתמש בסשן חדש
- **Cloudflare API Token** — לפריסת ה-Worker. סופק ע"י המשתמש (benzi.naor@gmail.com, account `7c5259865ad06b1a05dbff3e55d53027`). **לא נשמר ב-repo** (היה רק בקובץ זמני מחוץ ל-repo, נמחק עם הסשן). בקש מהמשתמש שוב אם צריך redeploy.
- אם משנים רק frontend — לא צריך token (GitHub Actions מטפל).

## מצב פתוח / TODO אפשריים
- **Apps Script לכתיבה חזרה:** הקוד ב-`worker/sheets-writeback.gs` (SHEET_ID מוטמע). המשתמש צריך לפרוס אותו כ-Web App (Execute as: Me, Access: Anyone) ולהדביק את ה-URL ב-אפליקציה → הגדרות → כתיבה לשיטס. אחרי זה הכתיבה אוטומטית (~5ש' + cron). ודא שהמשתמש עדכן לגרסת 3-העמודות האחרונה.
- **אייקון PWA מותקן:** לא מתעדכן לבד (מטמון OS) — צריך הסרה+הוספה מחדש למסך הבית. הקוד/פיצ'רים כן מתעדכנים דרך באנר העדכון.
- **iOS:** אין torch (פלאש) ואין התקנה תוכנתית (רק "הוסף למסך הבית" ידני). מטופל בקוד.
- **מחיקה/reset:** משתמשים ב-`reset_at` שגורם ל-resync מלא של כל העמדות (מאבד סריקות dirty לא-מסונכרנות בחלון קצר). תקין לתיקונים מזדמנים.

## בדיקות (scratchpad, לא ב-repo)
נעשו בדיקות עם playwright-core מותקן ב-scratchpad: פענוח ברקוד חי מ-video, סנכרון בין-עמדות מול mock, כתיבה לשיטס, פריסת עמודות. ל-e2e מול הענן האמיתי — הדפדפן ה-headless בסביבה **לא** מגיע לרשת; משתמשים ב-curl (דרך proxy) או mock מקומי.

## מבנה קבצים
`app.js` (לוגיקה) · `index.html` · `styles.css` · `sw.js` · `manifest.webmanifest` · `zxing.min.js` · `wigsstock.png` (לוגו) · `icon-*.png`/`apple-touch-icon.png` (אייקונים, נוצרים מהלוגו) · `sample-inventory.csv` (2000 דוגמה) · `test-barcodes.html` (מחולל ברקודים) · `build-single.js` · `worker/` (Worker + schema + wrangler + Apps Script + README).
