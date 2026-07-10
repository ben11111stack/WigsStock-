---
name: styled-dialogs
description: >-
  WigsStock rule — NEVER use native alert()/confirm()/prompt(). Every message and
  confirmation goes through the app's own styled dialog (uiAlert / uiConfirm in
  app.js). Use when adding any user message or confirmation, or when reviewing
  code for stray native dialogs.
---

# WigsStock: all dialogs are in-app and styled

The app must never show the browser's native `alert()`, `confirm()`, or
`prompt()` — they're unstyled Chrome popups that break the brand. Every message
and confirmation uses the styled dialog already built into `app.js`.

## Use the built-in helpers

Defined near the top of `app.js` (search for `In-app dialogs`):

- `uiAlert(message, opts?) → Promise<void>` — single button (default "הבנתי").
- `uiConfirm(message, opts?) → Promise<boolean>` — confirm + cancel
  (defaults "אישור" / "ביטול").

`opts`: `{ title, confirmText, cancelText, danger }`. `danger: true` makes the
primary button destructive (red) — use it for delete/reset actions.

```js
// confirmation (make the handler async)
if (!(await uiConfirm('לאפס את כל הסריקות?', { danger: true, confirmText: 'אפס' }))) return;

// message
uiAlert('נטענו 1,200 פאות.', { title: 'הושלם' });
```

The dialog reuses the app's `.modal` / `.btn` styles plus `.ui-dialog` / `.dlg-*`
in `styles.css`. It's RTL, closes on backdrop-click and Escape, confirms on
Enter, and focuses the primary button.

## When adding or reviewing code

- Never write `alert(` / `confirm(` / `prompt(` for the global dialogs. Use
  `uiAlert` / `uiConfirm`.
- `deferredPrompt.prompt()` (PWA install) is **not** a dialog — leave it.
- After editing `app.js` / `styles.css`, run `node tests/run.js` and
  `node build-single.js` (regenerates `wigsstock-app.html`), and bump `CACHE`
  in `sw.js`.
