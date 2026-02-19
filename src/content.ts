/**
 * content.ts — Chessable TTS Content Script
 *
 * Injected into every Chessable page. Watches the DOM for wrong-move events
 * and reads the accompanying explanation text aloud using the Web Speech API.
 */

import { processText } from './chess-notation';
import { enableOverlay, disableOverlay } from './debug-overlay';
import { createPanel } from './panel';
import {
  DEFAULT_SETTINGS,
  ExtensionMessage,
  SelectorGroup,
  TTSSettings,
} from './types';

// ─── Selectors ────────────────────────────────────────────────────────────────
// These target Chessable's actual DOM structure (discovered from page inspection).
// Update these if Chessable ships a redesign — use window.__chessableTTS.selectors
// in DevTools to inspect and test alternatives without reloading.

const SELECTORS: SelectorGroup = {
  wrongMoveContainer: [
    '[data-testid="moveNotification"]',
    '.board-footer',
    '.move-notification',
  ],
  explanationText: [
    '[data-testid="commentTextBlock"]',
    '.commentInVariation',
    '.comment-text-block',
    '[class*="commentText"]',
  ],
  wrongMoveIndicator: [
    '.icon--wrong',
    '.icon-circle-wrapper .icon--wrong',
    '[class*="icon--wrong"]',
    '[data-testid="moveNotification"] [class*="wrong"]',
  ],
  moveNotation: [
    '[data-testid="commentMove"] .commentMove',
    '[data-testid="commentSubMove"]',
    '.commentMove',
    '[class*="commentMove"]',
  ],
  commentContainer: [
    '#teachComment',
    '[data-testid="commentScrollContainer"]',
    '.comment-scroll-container',
    '[class*="teachComment"]',
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

  // Initialize debug overlay if it was enabled
  if (settings.debugMode) {
    enableOverlay(SELECTORS);
  }
});

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  switch (msg.type) {
    case 'SETTINGS_UPDATED':
      settings = { ...settings, ...msg.settings };

      // Sync debug overlay state
      if (msg.settings.debugMode !== undefined) {
        if (msg.settings.debugMode) {
          enableOverlay(SELECTORS);
        } else {
          disableOverlay();
        }
        panel?.setDebugChecked(settings.debugMode);
      }

      // Sync panel with new settings
      panel?.updateFromSettings(settings);
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
  const results: Element[] = [];
  for (const sel of selectors) {
    try {
      const els = root.querySelectorAll(sel);
      els.forEach((el) => {
        if (!results.includes(el)) results.push(el);
      });
    } catch {
      // Invalid selector — skip
    }
  }
  return results;
}

/** Map Chessable's data-piece attribute to SAN piece letter */
const PIECE_ATTR_TO_LETTER: Record<string, string> = {
  king:   'K',
  queen:  'Q',
  rook:   'R',
  bishop: 'B',
  knight: 'N',
};

function getVisibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, [aria-hidden="true"]').forEach((n) => n.remove());

  // Replace Chessable's SVG piece icons with their SAN letter.
  // e.g. <span class="commentMove__piece" data-piece="rook"><svg>…</svg></span> → "R"
  clone.querySelectorAll('.commentMove__piece, [data-piece]').forEach((pieceSpan) => {
    const pieceName = pieceSpan.getAttribute('data-piece')
                   ?? pieceSpan.getAttribute('aria-label')
                   ?? '';
    const letter = PIECE_ATTR_TO_LETTER[pieceName.toLowerCase()] ?? '';
    pieceSpan.replaceWith(letter);
  });

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

  // Strategy 2: search within comment containers
  const container = queryAny(SELECTORS.commentContainer, document);
  if (container) {
    const txt = getVisibleText(container).trim();
    if (txt.length > 10 && txt.length < 2000) return txt;
  }

  // Strategy 3: walk up the DOM from the trigger looking for substantial text
  if (triggerNode) {
    let node: Element | null = triggerNode;
    for (let depth = 0; depth < 6 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const txt = getVisibleText(node).trim();
      if (txt.length > 10 && txt.length < 2000) return txt;
    }
  }

  return '';
}

/**
 * Extract and speak the currently visible explanation panel text.
 * Used by the "Read current" button in the injected panel.
 */
function readCurrentExplanation(): void {
  // Try explanation text first
  const explanationEl = queryAny(SELECTORS.explanationText, document);
  if (explanationEl) {
    const txt = getVisibleText(explanationEl).trim();
    if (txt.length > 3) {
      speak(txt);
      return;
    }
  }

  // Try comment container
  const container = queryAny(SELECTORS.commentContainer, document);
  if (container) {
    const txt = getVisibleText(container).trim();
    if (txt.length > 3) {
      speak(txt);
      return;
    }
  }

  // Fallback: try all explanation selectors across the page
  const allExplanations = queryAllAny(SELECTORS.explanationText, document);
  for (const el of allExplanations) {
    const txt = getVisibleText(el).trim();
    if (txt.length > 3) {
      speak(txt);
      return;
    }
  }

  console.log('[ChessableTTS] No explanation text found on page.');
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

      // Check if the added node is or contains a move notification
      if (el.matches?.('[data-testid="moveNotification"]') ||
          el.querySelector?.('[data-testid="moveNotification"]')) {
        // Wait a tick for the notification content to populate
        setTimeout(() => {
          if (isWrongMoveVisible()) {
            handleWrongMove(el);
          }
        }, 100);
        break;
      }

      // Check if the added node is or contains a wrong-move icon
      if (el.matches?.('.icon--wrong') ||
          el.querySelector?.('.icon--wrong') ||
          el.matches?.('[class*="icon--wrong"]')) {
        handleWrongMove(el);
        break;
      }

      // Nodes added inside #teachComment (explanation text appearing)
      if (el.closest?.('#teachComment') ||
          el.matches?.('#teachComment') ||
          el.matches?.('[data-testid="commentScrollContainer"]') ||
          el.querySelector?.('[data-testid="commentTextBlock"]')) {
        if (isWrongMoveVisible()) {
          handleWrongMove(el);
          break;
        }
      }

      // Fallback: check className/id for wrong-move indicators
      const nodeStr = `${el.className ?? ''} ${el.id ?? ''}`;
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

    // ── Class attribute changes ────────────────────────────────────────────
    if (
      mutation.type === 'attributes' &&
      mutation.attributeName === 'class'
    ) {
      const el = mutation.target as Element;
      const className = el.className ?? '';

      // Detect icon--wrong being added (Chessable toggling wrong-move state)
      if (className.includes('icon--wrong')) {
        handleWrongMove(el);
      }

      // Fallback pattern matching
      if (/wrong|incorrect|mistake/i.test(className)) {
        handleWrongMove(el);
      }
    }

    // ── data-state / aria-hidden changes on notification elements ──────────
    if (
      mutation.type === 'attributes' &&
      (mutation.attributeName === 'data-state' || mutation.attributeName === 'aria-hidden')
    ) {
      const el = mutation.target as Element;
      if (el.matches?.('[data-testid="moveNotification"]') ||
          el.closest?.('[data-testid="moveNotification"]')) {
        if (isWrongMoveVisible()) {
          handleWrongMove(el);
        }
      }
    }
  }
});

// ─── Injected panel ───────────────────────────────────────────────────────────

let panel: ReturnType<typeof createPanel> | null = null;

function initPanel(): void {
  panel = createPanel({
    onToggleEnabled(enabled) {
      settings.enabled = enabled;
      chrome.storage.sync.set({ enabled });
      broadcastSettings({ enabled });
    },

    onVolumeChange(volume) {
      settings.volume = volume;
      chrome.storage.sync.set({ volume });
      broadcastSettings({ volume });
    },

    onReadCurrent() {
      readCurrentExplanation();
    },

    onToggleDebug(debugOn) {
      settings.debugMode = debugOn;
      chrome.storage.sync.set({ debugMode: debugOn });
      if (debugOn) {
        enableOverlay(SELECTORS);
      } else {
        disableOverlay();
      }
      broadcastSettings({ debugMode: debugOn });
    },
  });

  panel.updateFromSettings(settings);
  panel.mount();
}

function broadcastSettings(partial: Partial<TTSSettings>): void {
  // Broadcast to popup if it's listening
  try {
    chrome.runtime.sendMessage({
      type: 'SETTINGS_UPDATED',
      settings: partial,
    } as ExtensionMessage).catch(() => {
      // No listener — that's fine
    });
  } catch {
    // Extension context invalidated — ignore
  }
}

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

function bootstrap(): void {
  startObserver();
  initPanel();
}

if (document.body) {
  bootstrap();
} else {
  document.addEventListener('DOMContentLoaded', bootstrap);
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
