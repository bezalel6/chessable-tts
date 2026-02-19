/**
 * content.ts — Chessable TTS Content Script
 *
 * Injected into every Chessable page. Watches the DOM for wrong-move events
 * and reads the accompanying explanation text aloud using the Web Speech API.
 */

import { processText } from './chess-notation';
import {
  DEFAULT_SETTINGS,
  ExtensionMessage,
  SelectorGroup,
  TTSSettings,
} from './types';

// ─── Selectors ────────────────────────────────────────────────────────────────
// These target Chessable's current DOM structure.
// Update these if Chessable ships a redesign — use window.__chessableTTS.selectors
// in DevTools to inspect and test alternatives without reloading.

const SELECTORS: SelectorGroup = {
  wrongMoveContainer: [
    '.wrong-move-feedback',
    '.move-feedback.wrong',
    '.incorrect-move',
    '[class*="wrongMove"]',
    '[class*="incorrect"]',
    '.solution-feedback--wrong',
  ],
  explanationText: [
    '.move-comment',
    '.comment-text',
    '.explanation',
    '.move-explanation',
    '.feedback-text',
    '[class*="comment"]',
    '[class*="explanation"]',
    '[class*="feedback"]',
    '.chapter-text',
    '.variation-comment',
  ],
  wrongMoveIndicator: [
    '[class*="wrong"]',
    '[class*="incorrect"]',
    '[class*="mistake"]',
  ],
  moveNotation: [
    '.move-notation',
    '.san',
    '[class*="moveNotation"]',
    '[class*="move-san"]',
  ],
};

// ─── State ────────────────────────────────────────────────────────────────────

let settings: TTSSettings = { ...DEFAULT_SETTINGS };
let lastSpokenText = '';
let lastSpokenTime = 0;
const DEBOUNCE_MS = 800;

// ─── Load persisted settings ──────────────────────────────────────────────────

chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
  settings = { ...settings, ...(stored as Partial<TTSSettings>) };
});

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  switch (msg.type) {
    case 'SETTINGS_UPDATED':
      settings = { ...settings, ...msg.settings };
      break;
    case 'TEST_SPEAK':
      speak('Knight to f 3 check. This move attacks the queen on d 4 and forks the rook.');
      break;
  }
});

// ─── TTS ──────────────────────────────────────────────────────────────────────

function speak(text: string): void {
  if (!settings.enabled || !text.trim()) return;

  const now = Date.now();
  const cleaned = text.trim();

  // Debounce identical back-to-back utterances
  if (cleaned === lastSpokenText && now - lastSpokenTime < DEBOUNCE_MS) return;
  lastSpokenText = cleaned;
  lastSpokenTime = now;

  window.speechSynthesis.cancel();

  const processed = processText(cleaned);
  const utterance = new SpeechSynthesisUtterance(processed);

  utterance.rate   = settings.rate;
  utterance.pitch  = settings.pitch;
  utterance.volume = settings.volume;

  if (settings.voice) {
    const voices = window.speechSynthesis.getVoices();
    const voice  = voices.find((v) => v.name === settings.voice);
    if (voice) utterance.voice = voice;
  }

  utterance.onerror = (e: SpeechSynthesisErrorEvent) => {
    if (e.error !== 'interrupted') {
      console.warn('[ChessableTTS] SpeechSynthesis error:', e.error);
    }
  };

  window.speechSynthesis.speak(utterance);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function queryAny(selectors: string[], root: ParentNode = document): Element | null {
  for (const sel of selectors) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch {
      // Invalid selector — skip
    }
  }
  return null;
}

function queryAllAny(selectors: string[], root: ParentNode = document): Element[] {
  for (const sel of selectors) {
    try {
      const els = root.querySelectorAll(sel);
      if (els.length > 0) return Array.from(els);
    } catch {
      // Invalid selector — skip
    }
  }
  return [];
}

function getVisibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, [aria-hidden="true"]').forEach((n) => n.remove());
  return (clone as HTMLElement).innerText ?? clone.textContent ?? '';
}

// ─── Wrong-move handler ───────────────────────────────────────────────────────

/**
 * Try to find the move notation element near the trigger or in the document.
 */
function extractMoveNotation(triggerNode: Element | null): string {
  const moveEl =
    (triggerNode && queryAny(SELECTORS.moveNotation, triggerNode)) ??
    queryAny(SELECTORS.moveNotation, document);
  if (moveEl) {
    const txt = getVisibleText(moveEl).trim();
    if (txt.length > 0) return txt;
  }
  return '';
}

/**
 * Try to find explanation text using multiple strategies.
 */
function extractExplanation(triggerNode: Element | null): string {
  // Strategy 1: dedicated explanation element near or at the trigger
  const explanationEl =
    (triggerNode && queryAny(SELECTORS.explanationText, triggerNode)) ??
    queryAny(SELECTORS.explanationText, document);

  if (explanationEl) {
    const txt = getVisibleText(explanationEl).trim();
    if (txt.length > 3) return txt;
  }

  // Strategy 2: walk up the DOM from the trigger looking for substantial text
  if (triggerNode) {
    let node: Element | null = triggerNode;
    for (let depth = 0; depth < 6 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const txt = getVisibleText(node).trim();
      if (txt.length > 10 && txt.length < 2000) return txt;
    }
  }

  // Strategy 3: fallback to known Chessable panel selectors
  const panels = queryAllAny([
    '.chapter-content',
    '.move-list',
    '.variation-panel',
    '.comment-panel',
  ]);
  for (const panel of panels) {
    const txt = getVisibleText(panel).trim();
    if (txt.length > 10) return txt;
  }

  return '';
}

/**
 * Called when we believe a wrong move has just been played.
 * Extracts move notation and explanation text, then speaks
 * according to the user's readMoveFirst / readExplanation settings.
 */
function handleWrongMove(triggerNode: Element | null): void {
  const parts: string[] = [];

  if (settings.readMoveFirst) {
    const move = extractMoveNotation(triggerNode);
    if (move) parts.push(move);
  }

  if (settings.readExplanation) {
    const explanation = extractExplanation(triggerNode);
    if (explanation) parts.push(explanation);
  }

  // If both settings are off, nothing to speak
  if (parts.length > 0) {
    speak(parts.join('. '));
  }
}

// ─── Wrong-move visibility check ──────────────────────────────────────────────

function isWrongMoveVisible(): boolean {
  return SELECTORS.wrongMoveIndicator.some((sel) => {
    try { return !!document.querySelector(sel); }
    catch { return false; }
  });
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

const observer = new MutationObserver((mutations: MutationRecord[]) => {
  if (!settings.enabled) return;

  for (const mutation of mutations) {
    // ── Newly added nodes ──────────────────────────────────────────────────
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      const nodeStr = `${el.className ?? ''} ${el.id ?? ''}`;

      // The added node itself signals a wrong move
      if (/wrong|incorrect|mistake|error|retry/i.test(nodeStr)) {
        handleWrongMove(el);
        break;
      }

      // The added node contains an explanation element
      for (const sel of SELECTORS.explanationText) {
        try {
          if (el.matches(sel) || el.querySelector(sel)) {
            if (isWrongMoveVisible()) {
              handleWrongMove(el);
              break;
            }
          }
        } catch {
          // Invalid selector — skip
        }
      }
    }

    // ── Class attribute changes (board highlights, state flags) ────────────
    if (
      mutation.type === 'attributes' &&
      mutation.attributeName === 'class'
    ) {
      const el = mutation.target as Element;
      if (/wrong|incorrect|mistake/i.test(el.className ?? '')) {
        handleWrongMove(el);
      }
    }
  }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function startObserver(): void {
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-state', 'aria-hidden'],
  });
  console.log('[ChessableTTS] Observer active.');
}

if (document.body) {
  startObserver();
} else {
  document.addEventListener('DOMContentLoaded', startObserver);
}

// ─── Debug API ────────────────────────────────────────────────────────────────
// Access via `window.__chessableTTS` in DevTools on a Chessable page.

window.__chessableTTS = {
  speak,
  handleWrongMove:  () => handleWrongMove(null),
  get settings() { return settings; },
  selectors: SELECTORS,
  testNotation: (text: string) => speak(text),
};
