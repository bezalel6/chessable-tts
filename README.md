# Chessable TTS — Developer Edition

TypeScript + Webpack Chrome extension (Manifest V3) that reads move explanations aloud when you play an incorrect move on [Chessable](https://www.chessable.com), with full chess algebraic notation pronunciation.

---

## Project structure

```
chessable-tts-dev/
├── src/
│   ├── types.ts            — Shared interfaces & type definitions
│   ├── chess-notation.ts   — SAN → spoken English parser (pure functions)
│   ├── content.ts          — Content script: MutationObserver + TTS engine
│   └── popup.ts            — Popup UI controller
├── public/                 — Static assets, copied verbatim into dist/
│   ├── manifest.json
│   ├── popup.html
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── dist/                   — ⚙️ Build output (git-ignored). Load THIS in Chrome.
├── package.json
├── tsconfig.json
└── webpack.config.js
```

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

---

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Development build (with inline source maps)
npm run dev

# 3. Load the extension into Chrome
#    → chrome://extensions → Enable "Developer mode" → "Load unpacked" → select dist/
```

---

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run build`     | Production build — minified, no source maps |
| `npm run dev`       | Development build — with inline source maps |
| `npm run watch`     | Dev build that rebuilds automatically on file save |
| `npm run typecheck` | Full TypeScript type check via `tsc --noEmit` (no output files written) |
| `npm run clean`     | Delete `dist/` |

### Typical dev workflow

```bash
# Terminal 1 — keep webpack watching
npm run watch

# Terminal 2 — run type checking on demand (or set up your editor)
npm run typecheck
```

After each `watch` rebuild, click the **↺ refresh** icon on the extension card in `chrome://extensions`. There is no hot-reload for Chrome extensions — a manual refresh is required.

---

## Build output

Webpack produces two self-contained bundles (no shared chunk splitting, required for MV3):

| Bundle | Source | Purpose |
|--------|--------|---------|
| `dist/content.js` | `src/content.ts` + `src/chess-notation.ts` | Injected into every `chessable.com` page |
| `dist/popup.js`   | `src/popup.ts` | Runs inside `popup.html` |

`public/` is copied into `dist/` unchanged on every build.

---

## Architecture

### `types.ts`
Central source of truth for all shared interfaces:
- `TTSSettings` — the user's persisted settings object
- `ExtensionMessage` — discriminated union for popup ↔ content messages
- Chess types: `PieceLetter`, `File`, `Rank`, `Square`, `ParsedMove`
- `ChessableTTSDebug` — type for `window.__chessableTTS`

### `chess-notation.ts`
Pure functional module, no side effects, no Chrome APIs. Can be unit-tested in Node.js without a browser.

| Export | Description |
|--------|-------------|
| `parseMove(token)` | Parses a single SAN token → `ParsedMove \| null` |
| `moveToSpeech(parsed)` | Converts a `ParsedMove` → natural English string |
| `processText(text)` | Finds all move tokens in arbitrary prose and replaces them |

**Notation examples:**

| Input | Output |
|-------|--------|
| `Nf3` | Knight to f 3 |
| `Bxe5+` | Bishop takes e 5 check |
| `exd5` | e pawn takes d 5 |
| `O-O` | Kingside castle |
| `O-O-O` | Queenside castle |
| `Rxd8#` | Rook takes d 8 checkmate |
| `e8=Q` | pawn to e 8 promotes to Queen |
| `Nbd7` | Knight on b to d 7 |
| `R1e4` | Rook on 1 to e 4 |

### `content.ts`
Injected into every `chessable.com` page. Key responsibilities:
1. Loads settings from `chrome.storage.sync`
2. Listens for `SETTINGS_UPDATED` / `TEST_SPEAK` messages from the popup
3. Runs a `MutationObserver` watching for wrong-move DOM mutations
4. Extracts explanation text via three fallback strategies (selector → DOM walk → panel fallback)
5. Passes text through `processText()` then speaks it via the Web Speech API

### `popup.ts`
Manages the settings UI. Saves changes to `chrome.storage.sync` and broadcasts `SETTINGS_UPDATED` to all open Chessable tabs via `chrome.tabs.sendMessage`.

---

## Adapting to Chessable DOM changes

Chessable's class names may change after a UI update. The `SELECTORS` object at the top of `content.ts` controls everything:

```ts
const SELECTORS: SelectorGroup = {
  wrongMoveContainer: [ /* ... */ ],
  explanationText:    [ /* ... */ ],
  wrongMoveIndicator: [ /* ... */ ],
  moveNotation:       [ /* ... */ ],
};
```

### Debugging in the browser console

Open DevTools on a Chessable course page and use the exposed debug API:

```js
// Manually trigger as if a wrong move was played
window.__chessableTTS.handleWrongMove()

// Speak any text (with notation processing)
window.__chessableTTS.testNotation("After Nf3+ the queen on d4 is attacked")

// Inspect live settings
window.__chessableTTS.settings

// Inspect active selectors
window.__chessableTTS.selectors
```

---

## TypeScript configuration notes

`tsconfig.json` has `"noEmit": true` — this means `tsc` itself never writes files to disk, keeping type-checking decoupled from the build pipeline. Webpack's `ts-loader` overrides this per-invocation with `compilerOptions: { noEmit: false }` so it can receive compiled output. In dev/watch mode `transpileOnly: true` is also set for faster incremental rebuilds — full type safety is checked separately via `npm run typecheck`.

---

## Permissions

| Permission | Reason |
|-----------|--------|
| `storage` | Persist user settings across sessions |
| `activeTab` | Send test-speak message to the current tab |
| `host_permissions: chessable.com` | Inject content script into Chessable pages |

No data ever leaves the browser. All TTS is handled by the native Web Speech API.
