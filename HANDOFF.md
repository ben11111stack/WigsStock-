# WigsStock · Handoff (למפתח/סשן הבא)

אפליקציית **ספירת מלאי פאות** עם סריקת ברקוד, סנכרון ענן בין עמדות, וקריאה/כתיבה מול Google Sheets.
המסמך הזה מסכם את כל מה שצריך כדי להמשיך. **סטטוס: פרודוקשן, גרסה 1.11.0.**

## 🆕 מה חדש ב-1.11.0
- **פתיח לוגו מונפש** — האנימציה (`9801e3f0-6luxuryreveal.html` שהמשתמשת סיפקה) שולבה כ-`#splash` ב-`index.html` + CSS מוקדם ב-`styles.css` (מחלקות `sp-*`, מונפש רק תחת `.splash.run`). מנוהל ב-`playSplash()`/`dismissSplash()` (app.js): מתנגן בכל פתיחה, נסגר לבד אחרי ~2.7ש' או בהקשה. **הלוגו בפתיח משתמש ב-`wigsstock.png`** (הלוגו המלא עם הוורדמארק). אם תרצו רקע שקוף מושלם — הפילי `logo-t.png` שקוף והחליפי את ה-`src`.
- **הלוגו הקטן בכותרת מונפש כל הזמן** (`#hdrLogo`, מחלקות `hl-*`: sway + shimmer). לחיצה עליו מפעילה את הפתיח המלא. **מתג בהגדרות → מראה וצבע → "אנימציה בלוגו הקטן"** (`state.logoAnim`, `applyLogoAnim()`) מכבה **רק** את תנועת הלוגו הקטן; הפתיח בפתיחה ובלחיצה תמיד פועל.
- **כתיבת שם (ועוד) חזרה לשיטס:** `sheets-writeback.gs` נעשה גנרי — כותב עמודת **"שם"** (לעמודת השם הקיימת אם יש, אחרת יוצר; לא מוחק שמות קיימים בריק) ו-**"סטטוס (עודכן)"** בעמודה נפרדת (לא נוגע בעמודת הסטטוס המקורית). ה-Worker `doWriteback(env,countId,scriptUrl,fields)` מעביר `fields` ל-Apps Script; ה-endpoint `/api/writeback` קורא `body.fields`. באפליקציה `writebackFields()` בונה `{bc:{name,status}}` מ-`state.names`/`invNames`/`statusOverrides` ושולח ב-"כתוב עכשיו". ⚠️ **שמות נכתבים רק בכתיבה ידנית** ("כתוב עכשיו") — ה-cron/אוטו כותב רק סריקות. **צריך: redeploy ל-Worker + עדכון ה-Apps Script בגיליון (הדבקה מחדש) כדי שהעמודות החדשות ייכנסו לתוקף.**
- כפתור **"הזן"** במסך הסריקה (במקום "רשום"). `sw.js` CACHE = `wigsstock-v17` (נוסף `wigsstock.png`).

## 🆕 מה חדש ב-1.10.0 (הסשן האחרון — ענף `claude/endauf-continuation-thpuvg`)
- **מודל סטטוסים ניתן לעריכה** (`DEFAULT_STATUSES`, `statusVocab()`, `statusMeta`, `statusLabel`, `isInStore`): לכל סטטוס יש תווית עברית ודגל `inStore` (האם נספר במלאי). ניהול בהגדרות → **סטטוסים** (`renderStatusManager`): שינוי תווית, סימון "בחנות", הוספה/מחיקה, איפוס. סטטוסים חדשים מהשיטס נוספים אוטומטית (`ensureStatus`).
- **סטטוס ניתן לשינוי מכרטיס הפאה** — `state.statusOverrides` (barcode→status), שכבת override מקומית מעל המלאי. `statusOf()` / `effInv()` מחזירים את הסטטוס האפקטיבי; `reconcile()` משתמש ב-`effInv()`. ⚠️ **ה-override מקומי בלבד** — לא נכתב חזרה לשיטס (הכתיבה כותבת רק נסרק/תאריך/עמדה). אם רוצים שסטטוס יסונכרן — צריך להרחיב את ה-Apps Script + Worker.
- **שם לכל פאה** — `state.names` (עריכה מקומית, גובר) + `state.invNames` (מעמודת שם בגיליון, זיהוי ב-`detectColumns` → `nameCol`). `wigName()` מאחד. הכרטיס: שם ניתן לעריכה **ליד** הברקוד (אותו גודל). הדוחות מציגים עמודת **שם** בכל הקטגוריות (כולל חסרות).
- **תיקון באג הגלילה בדוחות** — `renderReport(force)` מדלג על רינדור כשה-signature (`reportSignature`) לא השתנה (פולינג ה-4ש' לא מוחק את ה-DOM יותר), ומשחזר אקורדיונים פתוחים + מיקום גלילה כשכן מרנדר. **קריאות אחרי עריכה מקומית מעבירות `force=true`.**
- **דיאלוגים מעוצבים במקום native** — `uiAlert` / `uiConfirm` (Promise-based, `.ui-dialog`/`.dlg-*` ב-CSS). **כלל: אף פעם לא `alert()`/`confirm()`/`prompt()` של הדפדפן.** מתועד כסקיל: `.claude/skills/styled-dialogs/` (פרויקט) ו-`~/.claude/skills/no-native-dialogs/` (גלובלי). היחיד שנשאר הוא `deferredPrompt.prompt()` (PWA install — לא דיאלוג).
- אוחדה הלשון: **"סטטוס"** בכל מקום (במקום "סטטוס בשיטס").
- בדיקות: `node tests/run.js` → **48 passed**. נבנה `wigsstock-app.html`, `sw.js` CACHE = `wigsstock-v16`.

**פתוח להמשך:** סנכרון שמות + override-סטטוס בין עמדות (דורש שינוי backend); מחיר/היסטוריה בכרטיס (יש placeholder "מחיר והיסטוריה — בקרוב").

## ✅ מצב הענן (10/07/2026) — תקין
ה-Worker חי ותקין: `curl https://wigsstock-sync.benzi-naor.workers.dev/api/health` → `{"ok":true,"service":"wigsstock-sync"}`.
טעינה מהשיטס, סנכרון בין עמדות, וכתיבה אוטומטית חזרה לשיטס (throttle 5ש' + cron) — כולם עובדים.
(התקלה שתועדה כאן בעבר נפתרה — ה-Worker נפרס מחדש.)

## מה חדש בגרסה 1.6.0
- **נורמליזציית ברקוד** (`normBarcode`) — מוחלת זהה בייבוא מהשיטס, בכל סריקה ובמיזוג. מטפלת ברווחים, גרש מוביל (`'01234`), ואפסים מובילים (`01234`==`1234`) כדי שלא ייווצרו "חסר"+"לא מוכר" מזויפים.
- **חיפוש חי בדוח**, **לחיצה על ריבוע בדאשבורד** קופצת לקטגוריה, **פילוח לפי עמדה/עובדת**.
- **Undo/Redo** לסריקות + **מצב באטש** עם רשימת "סריקות אחרונות" וביטול מהיר לכל פריט.
- **מונה "ממתינות לסנכרון"** גלוי במסך הסריקה.
- **ייצוא ל-Excel (xlsx) אמיתי** — כותב xlsx בלי ספריות (zip "stored" + CRC32, תאים inlineStr). פותר ג'יבריש עברית ב-Excel. גם **תצוגה מקדימה** של כל הדוחות בתוך האפליקציה.
- **בדיקות אוטומטיות** (`tests/run.js`, ללא תלויות) + workflow CI (`.github/workflows/tests.yml`) שרץ בכל push/PR ומוודא שגם `wigsstock-app.html` מעודכן.
- **אבטחה קלה (רשות) ב-Worker**: אם מגדירים secret בשם `API_KEY` ב-Cloudflare, כל ה-POST-ים דורשים כותרת `x-api-key` תואמת (בקריאה — פתוח). כבוי כברירת מחדל → תואם לאחור. באפליקציה יש שדה "מפתח גישה" בהגדרות מתקדמות. **מפעילים ב-`npx wrangler secret put API_KEY` + redeploy** (דורש טוקן מהמשתמש). בנוסף: תקרות קלט (`MAX_*`) תמיד פעילות (אחרי redeploy).

**הכל committed + pushed לענף `claude/improvements-features-ygud1v`.**

## ⚠️ פריסה — שים לב
- **ה-Pages מוגן לפי ענף:** ה-environment `github-pages` מאפשר פריסה **רק מהענף `claude/inventory-barcode-scanner-4w4fbf`** (environment protection rule ברמת ה-repo, לא בקובץ). לכן דחיפה ל-`claude/improvements-features-ygud1v` **לא** מפרסת לאוויר — ניסיון כזה נכשל מיד. **כדי להעלות את גרסה 1.6.0 לאוויר:** או (א) למזג את הענף הזה ל-`claude/inventory-barcode-scanner-4w4fbf` (הוא מפרס אוטומטית), או (ב) לעדכן ב-GitHub → Settings → Environments → github-pages את רשימת הענפים המורשים כך שתכלול את הענף הזה.
- ה-**Worker נפרס אוטומטית** דרך `.github/workflows/deploy-worker.yml` בכל push ל-`worker/**` בענף הפרסום (או ידנית ב-workflow_dispatch). דורש **GitHub Secret** עם ה-Cloudflare API Token (מקבל את השמות `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` / `CLOUDFLARE_TOKEN` / `CLOUDFLARE_WORKERS_TOKEN`). ה-`account_id` נמצא ב-`wrangler.toml`. כך אין צורך להזין את הטוקן שוב בכל סשן. (עדיין אפשר גם ידנית: `npx wrangler deploy` מתוך `worker/`.)

## קישורים
- **אפליקציה חיה:** https://ben11111stack.github.io/WigsStock-/ (GitHub Pages)
- **Repo:** `ben11111stack/WigsStock-` (public) · branch עבודה נוכחי: `claude/improvements-features-ygud1v`
- **Backend (Cloudflare Worker):** https://wigsstock-sync.benzi-naor.workers.dev
- **גיליון המלאי (של המשתמש):** Google Sheet id `17Sem_IwgporhMsXEhVvW7ysIamzc_Ktxv-7molhp35k` (משותף "מציג")

## ארכיטקטורה (local-first)
- **Frontend:** vanilla JS, ללא build. `index.html` + `app.js` + `styles.css` + מנועי סריקה (`zxing-wasm.min.js` + `zxing_reader.wasm` + `zxing.min.js`). PWA (manifest + `sw.js`).
  - סריקה: לולאה ידנית שמציירת פריים ל-canvas ומפענחת עם **zxing-cpp/WASM** (`ZXingWASM.readBarcodes`, ראה `initWasmEngine`/`scanTick` ב-app.js). המנוע הוחלף ב-1.14.0 כי ה-port הישן של ZXing ל-JS לא פענח את תגי ה-Code 128 המודפסים של החנות (גם בתמונה חדה). ה-JS הישן (`zxing.min.js`, `makeReader`) נשאר כנסיגה אוטומטית לדפדפן בלי WebAssembly.
  - `zxing-wasm.min.js` נבנה מ-npm `zxing-wasm@3` (reader בלבד) עם esbuild ל-IIFE גלובלי `ZXingWASM`; `zxing_reader.wasm` הוא הבינארי שלצידו (נטען עם `locateFile`, ובקובץ הבודד מוטמע base64).
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
- **Frontend:** push ל-branch → GitHub Actions (`.github/workflows/deploy-pages.yml`) בונה ופורס ל-Pages אוטומטית. אחרי כל שינוי קוד לקוח **במפ את `CACHE` ב-`sw.js`** (כרגע `wigsstock-v10`) כדי שבאנר "עדכן עכשיו" יופיע למשתמשים.
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
