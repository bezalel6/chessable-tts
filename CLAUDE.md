# Chessable TTS — Claude Code Guide

Chrome extension (Manifest V3) that reads Chessable move explanations aloud when
an incorrect move is played, with proper chess algebraic notation pronunciation.

---

## Commands

```bash
npm run build       # Production build → dist/ (minified, no source maps)
npm run dev         # Development build → dist/ (with inline source maps)
npm run watch       # Dev build, rebuilds on every file save
npm run typecheck   # Full tsc type-check, no output written
npm run clean       # Delete dist/
```

After any build, reload the extension in Chrome:
`chrome://extensions` → click **↺** on the Chessable TTS card.

---

## Project layout

```
src/
  types.ts            — All shared interfaces & type definitions (start here)
  chess-notation.ts   — Pure SAN → spoken English parser; no Chrome/DOM deps
  content.ts          — Content script: MutationObserver + Web Speech API
  popup.ts            — Popup UI: reads/writes chrome.storage.sync, sends messages
public/               — Static assets copied verbatim into dist/ by webpack
  manifest.json
  popup.html
  icons/
dist/                 — Build output. Load this folder in Chrome. Never edit by hand.
webpack.config.js     — Two entry points: content.ts → content.js, popup.ts → popup.js
tsconfig.json         — noEmit:true (tsc is typecheck-only; webpack does the build)
```

---

## Architecture

### Message flow
```
popup.ts  ──(chrome.tabs.sendMessage)──▶  content.ts
             SETTINGS_UPDATED | TEST_SPEAK
```
All message shapes are typed in `types.ts` as the `ExtensionMessage` discriminated union.
Adding a new message type: add the variant to `ExtensionMessage` first, then handle it
in `content.ts`'s `chrome.runtime.onMessage` listener.

### Settings
`TTSSettings` in `types.ts` is the canonical shape. `DEFAULT_SETTINGS` (also in `types.ts`)
is the fallback used by both the popup and the content script. When adding a new setting:
1. Add the field to `TTSSettings` and `DEFAULT_SETTINGS` in `types.ts`
2. Add the control to `public/popup.html`
3. Wire it up in `popup.ts` (`readSettings`, `saveAndBroadcast`, load block)
4. Consume it in `content.ts`

### Chess notation pipeline
```
raw text
  └─▶ processText()        — regex scans for SAN tokens in prose
        └─▶ parseMove()    — tokenises one SAN string → ParsedMove | null
              └─▶ moveToSpeech() — ParsedMove → natural English string
```
`chess-notation.ts` is pure functions with no side effects. It can be tested in
Node.js without a browser. The regex in `processText` is the most fragile part —
test changes against the notation table in README.md.

### DOM observation strategy (`content.ts`)
The `MutationObserver` watches for:
1. **Added nodes** whose `className`/`id` matches `/wrong|incorrect|mistake|error|retry/i`
2. **Added nodes** containing an `explanationText` selector, when a wrong-move indicator is visible
3. **Class attribute changes** matching the same wrong/incorrect/mistake pattern

`handleWrongMove` then tries three extraction strategies in order:
1. Query `SELECTORS.explanationText` near/at the trigger node
2. Walk up the DOM (max 6 levels) looking for text 10–2000 chars
3. Fallback to known panel selectors (`.chapter-content`, `.variation-panel`, etc.)

---

## Key constraints

- **No chunk splitting.** `optimization.splitChunks: false` is required — MV3 content
  scripts cannot lazy-load webpack chunks without a background service worker.
- **Inline source maps only.** Chrome blocks external `.map` file requests for
  extensions; use `devtool: 'inline-source-map'` in dev mode.
- **`noEmit: true` in tsconfig** — `tsc` is purely for type-checking. `ts-loader`
  overrides this with `compilerOptions: { noEmit: false }` at build time.
- **`transpileOnly: true` in dev** — faster watch rebuilds; run `npm run typecheck`
  separately for full type safety.

---

## Adapting to Chessable DOM changes

Chessable occasionally ships redesigns. The `SELECTORS` constant at the top of
`content.ts` (typed as `SelectorGroup` from `types.ts`) controls all DOM queries.

To debug in a live Chessable tab, open DevTools and use:
```js
window.__chessableTTS.handleWrongMove()          // simulate wrong move
window.__chessableTTS.testNotation("Nf3+ wins")  // test TTS + notation
window.__chessableTTS.settings                   // inspect live settings
window.__chessableTTS.selectors                  // inspect active selectors
```

---

## TypeScript strictness

All strict flags are on, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. In practice this means:
- Array index access returns `T | undefined` — guard with `arr[0] !== undefined`
- Optional properties (`foo?: string`) cannot be assigned `undefined` explicitly

---

## Notation reference

| SAN | Spoken |
|-----|--------|
| `Nf3` | Knight to f 3 |
| `Bxe5+` | Bishop takes e 5 check |
| `exd5` | e takes d 5 |
| `O-O` | Kingside castle |
| `O-O-O` | Queenside castle |
| `Rxd8#` | Rook takes d 8 checkmate |
| `e8=Q` | e 8 promotes to Queen |
| `Nbd7` | Knight on b to d 7 |
| `R1e4` | Rook on 1 to e 4 |
| `e8=Q+` | e 8 promotes to Queen check |