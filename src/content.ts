/**
 * content.ts — Chessable TTS Content Script
 *
 * Injected into every Chessable page. Watches the DOM for wrong-move events
 * and reads the accompanying explanation text aloud using the Web Speech API.
 *
 * Uses a state machine to prevent duplicate/overlapping speech:
 *   IDLE → DETECTING (300ms coalesce window) → SPEAKING → COOLDOWN (1.5s) → IDLE
 */

import { highlightSquare, clearHighlights } from './board-highlighter';
import { processTextWithMoveMap } from './chess-notation';
import { enableOverlay, disableOverlay } from './debug-overlay';
import { createPanel } from './panel';
import {
  DEFAULT_SETTINGS,
  ExtensionMessage,
  MoveRange,
  SelectorGroup,
  TTSSettings,
  TTSState,
} from './types';
import {
  prepareHighlighting,
  highlightWordByProcessedIndex,
  clearWordHighlighting,
  WordMapping,
} from './word-highlighter';

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
    '.commentInMove',
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
    '[data-san]',
    '.textMoveHighlighted',
    '.whiteMove[data-san]',
    '.blackMove[data-san]',
    '[data-testid="commentMove"] .commentMove',
    '[data-testid="commentSubMove"]',
    '.commentMove',
  ],
  commentContainer: [
    '#teachComment',
    '#theOpeningMoves',
    '[data-testid="commentScrollContainer"]',
    '.comment-scroll-container',
    '[class*="teachComment"]',
  ],
};

// ─── Settings ─────────────────────────────────────────────────────────────────

let settings: TTSSettings = { ...DEFAULT_SETTINGS };

// ─── State machine ────────────────────────────────────────────────────────────

let state: TTSState = 'idle';
let detectTimer: ReturnType<typeof setTimeout> | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
let collectedTriggers: Element[] = [];
const DETECT_WINDOW_MS = 300;
const COOLDOWN_MS = 1500;

// ─── Word highlighting + playback state ──────────────────────────────────────

let currentWordMapping: WordMapping | null = null;
let currentRawText = '';
let currentProcessedText = '';
let processedWordStarts: number[] = [];
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

// ─── Timed board highlighting state ──────────────────────────────────────────

let currentMoveRanges: MoveRange[] = [];
let currentHighlightedSquare: string | null = null;

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
    case 'SETTINGS_UPDATED': {
      const prev = { ...settings };
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

      // If disabled mid-speech, cancel immediately
      if (msg.settings.enabled === false && state === 'speaking') {
        window.speechSynthesis.cancel();
        clearHighlights();
        resetToIdle();
      }

      // If a speech-affecting setting changed mid-speech, restart with new settings
      if (state === 'speaking' && (
        msg.settings.rate !== undefined && msg.settings.rate !== prev.rate ||
        msg.settings.pitch !== undefined && msg.settings.pitch !== prev.pitch ||
        msg.settings.volume !== undefined && msg.settings.volume !== prev.volume ||
        msg.settings.voice !== undefined && msg.settings.voice !== prev.voice
      )) {
        restartSpeechWithNewSettings();
      }

      // Sync panel with new settings
      panel?.updateFromSettings(settings);
      break;
    }
    case 'TEST_SPEAK':
      speak('Knight to f 3 check. This move attacks the queen on d 4 and forks the rook.');
      break;
  }
});

// ─── Self-mutation filter ─────────────────────────────────────────────────────

function isOwnMutation(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return !!(
    el.closest?.('#chessable-tts-panel') ||
    el.hasAttribute?.('data-chtts-highlight') ||
    el.closest?.('[data-chtts-highlight]') ||
    el.hasAttribute?.('data-chtts-debug') ||
    el.closest?.('[data-chtts-debug]') ||
    el.hasAttribute?.('data-chtts-word') ||
    el.closest?.('[data-chtts-word]')
  );
}

// ─── State transition functions ───────────────────────────────────────────────

/**
 * Entry point from the MutationObserver. Coalesces rapid-fire triggers
 * into a single speech event using a 300ms detection window.
 */
function onWrongMoveDetected(triggerNode: Element): void {
  if (state === 'speaking' || state === 'cooldown') return;

  collectedTriggers.push(triggerNode);

  if (state === 'idle') {
    state = 'detecting';
    detectTimer = setTimeout(onDetectWindowClosed, DETECT_WINDOW_MS);
    return;
  }

  // state === 'detecting' — reset the timer to absorb more mutations
  if (detectTimer !== null) {
    clearTimeout(detectTimer);
  }
  detectTimer = setTimeout(onDetectWindowClosed, DETECT_WINDOW_MS);
}

/**
 * Called when the 300ms detection window closes. Verifies the wrong move
 * is still visible, extracts text, and starts speech.
 */
function onDetectWindowClosed(): void {
  detectTimer = null;

  // Re-verify the wrong-move indicator is still present
  if (!isWrongMoveVisible()) {
    collectedTriggers = [];
    state = 'idle';
    return;
  }

  // Use the first collected trigger for text extraction context
  const triggerNode = collectedTriggers[0] ?? null;
  collectedTriggers = [];

  const parts: string[] = [];

  if (settings.readMoveFirst) {
    const move = extractMoveNotation(triggerNode);
    if (move) parts.push(move);
  }

  if (settings.readExplanation) {
    const explanation = extractExplanation(triggerNode);
    if (explanation) parts.push(explanation);
  }

  if (parts.length === 0) {
    state = 'idle';
    return;
  }

  // Set up word highlighting on the explanation element
  const explanationEl = findExplanationElement(triggerNode);
  const rawText = parts.join('. ');
  if (explanationEl) {
    currentWordMapping = prepareHighlighting(explanationEl, rawText);
  }

  doSpeak(rawText);
}

/**
 * Called when speech finishes (onend or onerror). Clears highlights
 * and enters cooldown to absorb any trailing mutations.
 */
function onSpeechEnd(): void {
  clearHighlights();
  currentHighlightedSquare = null;
  clearWordHighlighting(currentWordMapping);
  currentWordMapping = null;
  panel?.setPlaybackState('idle');
  clearKeepAlive();

  state = 'cooldown';
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    state = 'idle';
  }, COOLDOWN_MS);
}

/**
 * Hard reset — clears all timers and returns to idle. Used by manual
 * "Read Current" to force a clean slate.
 */
function resetToIdle(): void {
  if (detectTimer !== null) {
    clearTimeout(detectTimer);
    detectTimer = null;
  }
  if (cooldownTimer !== null) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  clearWordHighlighting(currentWordMapping);
  currentWordMapping = null;
  currentHighlightedSquare = null;
  panel?.setPlaybackState('idle');
  clearKeepAlive();
  collectedTriggers = [];
  state = 'idle';
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

/**
 * Compute the character offset of each word start in the given text.
 * Used to map onboundary charIndex → word index.
 */
function computeWordStarts(text: string): number[] {
  const starts: number[] = [];
  const regex = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    starts.push(m.index);
  }
  return starts;
}

/** Clear the Chrome focus-loss keepalive timer. */
function clearKeepAlive(): void {
  if (keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

/**
 * If speech is currently active (speaking or paused), cancel it and
 * restart with the same text using the latest settings. This makes
 * rate/pitch/volume/voice changes take effect immediately.
 */
function restartSpeechWithNewSettings(): void {
  if (state !== 'speaking') return;
  if (!currentProcessedText) return;

  window.speechSynthesis.cancel();
  clearHighlights();
  currentHighlightedSquare = null;
  clearWordHighlighting(currentWordMapping);
  currentWordMapping = null;
  clearKeepAlive();

  // Re-set up word highlighting
  const explanationEl = findExplanationElement(null);
  if (explanationEl) {
    currentWordMapping = prepareHighlighting(explanationEl, currentRawText);
  }

  // Speak with updated settings (doSpeakProcessed reads from `settings`)
  doSpeakProcessed(currentProcessedText);
}

/**
 * Core speech function. Called only from the state machine (onDetectWindowClosed)
 * or from readCurrentExplanation/speak. The state machine guarantees no concurrent
 * speech, so there is no cancel or debounce needed here.
 */
function doSpeak(text: string): void {
  if (!settings.enabled || !text.trim()) {
    state = 'idle';
    return;
  }

  state = 'speaking';

  const cleaned = text.trim();

  // Process text and build move range map for timed board highlighting
  const { processed, moveRanges } = processTextWithMoveMap(cleaned);
  currentMoveRanges = moveRanges;
  currentHighlightedSquare = null;

  // Store for restart
  currentRawText = cleaned;
  currentProcessedText = processed;

  doSpeakProcessed(processed);
}

/**
 * Speak already-processed text. Used by doSpeak() and by restart (which
 * re-uses the previously processed text without re-processing).
 */
function doSpeakProcessed(processed: string): void {
  // Precompute word start positions for onboundary mapping
  processedWordStarts = computeWordStarts(processed);

  panel?.setPlaybackState('speaking');

  const utterance = new SpeechSynthesisUtterance(processed);

  utterance.rate   = settings.rate;
  utterance.pitch  = settings.pitch;
  utterance.volume = settings.volume;

  if (settings.voice) {
    const voices = window.speechSynthesis.getVoices();
    const voice  = voices.find((v) => v.name === settings.voice);
    if (voice) utterance.voice = voice;
  }

  // Word boundary tracking for word + board highlighting
  utterance.onboundary = (e: SpeechSynthesisEvent) => {
    if (e.name !== 'word') return;

    // Word highlighting in the explanation text
    if (currentWordMapping) {
      const wordIdx = processedWordStarts.findIndex((start, i) => {
        const nextStart = processedWordStarts[i + 1] ?? Infinity;
        return e.charIndex >= start && e.charIndex < nextStart;
      });
      if (wordIdx >= 0) {
        highlightWordByProcessedIndex(currentWordMapping, wordIdx);
      }
    }

    // Timed board square highlighting — find which move range the cursor is in
    const activeRange = currentMoveRanges.find(
      (r) => e.charIndex >= r.charStart && e.charIndex < r.charEnd,
    );
    const targetSquare = activeRange?.square ?? null;

    if (targetSquare !== currentHighlightedSquare) {
      clearHighlights();
      if (targetSquare) {
        highlightSquare(targetSquare);
      }
      currentHighlightedSquare = targetSquare;
    }
  };

  utterance.onend = () => {
    onSpeechEnd();
  };

  utterance.onerror = (e: SpeechSynthesisErrorEvent) => {
    if (e.error !== 'interrupted') {
      console.warn('[ChessableTTS] SpeechSynthesis error:', e.error);
    }
    onSpeechEnd();
  };

  window.speechSynthesis.speak(utterance);

  // Chrome bug workaround: speech can stop after ~15s when tab loses focus.
  // A pause+resume cycle keeps it alive.
  clearKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!window.speechSynthesis.speaking) {
      clearKeepAlive();
      return;
    }
    if (!window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 10000);
}

/**
 * Public speak function — used by TEST_SPEAK, testNotation, and direct debug API.
 * Cancels any ongoing speech, resets state, and speaks immediately.
 */
function speak(text: string): void {
  window.speechSynthesis.cancel();
  clearHighlights();
  resetToIdle();
  doSpeak(text);
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

/** Map Chessable's data-piece attribute (English name) to SAN piece letter */
const PIECE_ATTR_TO_LETTER: Record<string, string> = {
  king:   'K',
  queen:  'Q',
  rook:   'R',
  bishop: 'B',
  knight: 'N',
};

/**
 * Extract readable text from a DOM element, converting Chessable's rich
 * move notation (SVG piece icons, data-san attributes) into plain SAN text.
 */
function getVisibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, [aria-hidden="true"]').forEach((n) => n.remove());

  // Strip move number divs (e.g. <div class="openingNum">3.</div>) to avoid
  // duplication — move numbers are already embedded in inline move refs.
  clone.querySelectorAll('.openingNum').forEach((n) => n.remove());

  // Replace inline move references that have data-san with their clean SAN.
  // These elements often contain SVG piece icons that would otherwise be lost.
  // e.g. <span data-san="Nxe5">3.<svg knight/>xe5</span> → "Nxe5"
  // Only replace elements that look like inline move refs (have an index-style id
  // or commentMove classes), NOT the main move list items.
  clone.querySelectorAll('[data-san].commentMoveSmall, [data-san].commentMoveSmallMargin').forEach((moveRef) => {
    const san = moveRef.getAttribute('data-san') ?? '';
    if (san) {
      moveRef.replaceWith(` ${san} `);
    }
  });

  // Replace Chessable's SVG piece icons with their SAN letter.
  // e.g. <span class="commentMove__piece" data-piece="rook"><svg>…</svg></span> → "R"
  clone.querySelectorAll('.commentMove__piece').forEach((pieceSpan) => {
    const pieceName = pieceSpan.getAttribute('data-piece')
                   ?? pieceSpan.getAttribute('aria-label')
                   ?? '';
    const letter = PIECE_ATTR_TO_LETTER[pieceName.toLowerCase()] ?? '';
    pieceSpan.replaceWith(letter);
  });

  // Replace annotation symbols with their human-readable title if available.
  // e.g. <span class="annotation" data-original-title="Good move">!</span>
  clone.querySelectorAll('.annotation').forEach((ann) => {
    const title = ann.getAttribute('data-original-title');
    if (title) {
      ann.replaceWith(` (${title})`);
    } else {
      ann.remove();
    }
  });

  return (clone as HTMLElement).innerText ?? clone.textContent ?? '';
}

// ─── Explanation element lookup ────────────────────────────────────────────────

/**
 * Find the DOM element containing explanation text near the trigger.
 * Same lookup strategy as extractExplanation() but returns the element itself
 * so we can wrap its words for highlighting.
 */
function findExplanationElement(triggerNode: Element | null): Element | null {
  // Strategy 1: dedicated explanation element near or at the trigger
  const explanationEl =
    (triggerNode && queryAny(SELECTORS.explanationText, triggerNode)) ??
    queryAny(SELECTORS.explanationText, document);
  if (explanationEl) {
    const txt = getVisibleText(explanationEl).trim();
    if (txt.length > 3) return explanationEl;
  }

  // Strategy 2: comment container
  const container = queryAny(SELECTORS.commentContainer, document);
  if (container) {
    const txt = getVisibleText(container).trim();
    if (txt.length > 10 && txt.length < 2000) return container;
  }

  // Strategy 3: walk up from trigger
  if (triggerNode) {
    let node: Element | null = triggerNode;
    for (let depth = 0; depth < 6 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const txt = getVisibleText(node).trim();
      if (txt.length > 10 && txt.length < 2000) return node;
    }
  }

  return null;
}

// ─── Wrong-move handler ───────────────────────────────────────────────────────

/**
 * Try to find the move notation element near the trigger or in the document.
 * Prefers the `data-san` attribute (clean SAN) over visible text extraction.
 */
function extractMoveNotation(triggerNode: Element | null): string {
  // Strategy 1: look for elements with data-san near the trigger
  if (triggerNode) {
    const sanEl = triggerNode.querySelector?.('[data-san]')
                ?? triggerNode.closest?.('[data-san]');
    if (sanEl) {
      const san = sanEl.getAttribute('data-san') ?? '';
      if (san) return san;
    }
  }

  // Strategy 2: find the currently highlighted move in the opening moves panel
  const highlighted = document.querySelector('.textMoveHighlighted[data-san]');
  if (highlighted) {
    const san = highlighted.getAttribute('data-san') ?? '';
    if (san) return san;
  }

  // Strategy 3: fallback to querying move notation selectors
  const moveEl =
    (triggerNode && queryAny(SELECTORS.moveNotation, triggerNode)) ??
    queryAny(SELECTORS.moveNotation, document);
  if (moveEl) {
    // Prefer data-san if present
    const san = moveEl.getAttribute('data-san') ?? '';
    if (san) return san;
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
 * Collect explanation text near a highlighted move element.
 * Walks through subsequent siblings looking for comment/explanation elements
 * until the next move element is encountered.
 */
function collectExplanationNearMove(moveEl: Element): string {
  const parts: string[] = [];

  // Get the SAN of the move itself
  const san = moveEl.getAttribute('data-san') ?? '';
  if (san) parts.push(san);

  // Walk siblings after the move to collect explanation text
  let sibling = moveEl.nextElementSibling;
  for (let i = 0; i < 20 && sibling; i++) {
    // Stop at the next move element (another clickable move, not a sub-variation move)
    if (sibling.hasAttribute('data-san') &&
        !sibling.classList.contains('commentMoveSmall') &&
        !sibling.classList.contains('commentMoveSmallMargin')) {
      break;
    }

    // Collect text from comment/explanation elements
    if (sibling.classList.contains('commentInVariation') ||
        sibling.classList.contains('commentInMove') ||
        sibling.matches?.('[data-testid="commentTextBlock"]') ||
        sibling.matches?.('[class*="commentText"]')) {
      const txt = getVisibleText(sibling).trim();
      if (txt.length > 1) parts.push(txt);
    }

    sibling = sibling.nextElementSibling;
  }

  return parts.join('. ');
}

/**
 * Extract and speak the currently visible explanation panel text.
 * Used by the "Read current" button in the injected panel.
 *
 * This ALWAYS works regardless of state — it cancels ongoing speech,
 * resets the state machine, and speaks immediately.
 */
function readCurrentExplanation(): void {
  // Force cancel and reset so manual reads always work
  window.speechSynthesis.cancel();
  clearHighlights();
  resetToIdle();

  /**
   * Helper: set up word highlighting on an element before speaking.
   */
  function speakWithHighlighting(el: Element | null, text: string): void {
    if (el) {
      currentWordMapping = prepareHighlighting(el, text);
    }
    doSpeak(text);
  }

  // Strategy 1: Find the highlighted move in #theOpeningMoves and read its context
  const highlighted = document.querySelector('.textMoveHighlighted[data-san]');
  if (highlighted) {
    const txt = collectExplanationNearMove(highlighted);
    if (txt.length > 3) {
      // The explanation spans multiple siblings — highlight the comment container
      const commentContainer = highlighted.closest('#theOpeningMoves')
                             ?? queryAny(SELECTORS.commentContainer, document);
      speakWithHighlighting(commentContainer, txt);
      return;
    }
  }

  // Strategy 2: Try #teachComment — the wrong-move explanation panel
  const teachComment = document.querySelector('#teachComment');
  if (teachComment) {
    const txt = getVisibleText(teachComment).trim();
    if (txt.length > 3) {
      speakWithHighlighting(teachComment, txt);
      return;
    }
  }

  // Strategy 3: Try dedicated explanation text selectors
  const explanationEl = queryAny(SELECTORS.explanationText, document);
  if (explanationEl) {
    const txt = getVisibleText(explanationEl).trim();
    if (txt.length > 3) {
      speakWithHighlighting(explanationEl, txt);
      return;
    }
  }

  // Strategy 4: Try any comment container
  const container = queryAny(SELECTORS.commentContainer, document);
  if (container) {
    const txt = getVisibleText(container).trim();
    if (txt.length > 3) {
      speakWithHighlighting(container, txt);
      return;
    }
  }

  // Strategy 5: Fallback — try all explanation selectors across the page
  const allExplanations = queryAllAny(SELECTORS.explanationText, document);
  for (const el of allExplanations) {
    const txt = getVisibleText(el).trim();
    if (txt.length > 3) {
      speakWithHighlighting(el, txt);
      return;
    }
  }

  console.log('[ChessableTTS] No explanation text found on page.');
}

// ─── Wrong-move visibility check ──────────────────────────────────────────────

function isWrongMoveVisible(): boolean {
  return SELECTORS.wrongMoveIndicator.some((sel) => {
    try { return !!document.querySelector(sel); }
    catch { return false; }
  });
}

// ─── MutationObserver trigger predicates ──────────────────────────────────────

function isWrongMoveTrigger(el: Element): boolean {
  // Direct move notification
  if (el.matches?.('[data-testid="moveNotification"]') ||
      el.querySelector?.('[data-testid="moveNotification"]')) {
    return true;
  }

  // Wrong-move icon
  if (el.matches?.('.icon--wrong') ||
      el.querySelector?.('.icon--wrong') ||
      el.matches?.('[class*="icon--wrong"]')) {
    return true;
  }

  // Nodes inside #teachComment or comment scroll container
  if (el.closest?.('#teachComment') ||
      el.matches?.('#teachComment') ||
      el.matches?.('[data-testid="commentScrollContainer"]') ||
      el.querySelector?.('[data-testid="commentTextBlock"]')) {
    return true;
  }

  // Fallback: className/id matching for wrong/incorrect/mistake
  const nodeStr = `${el.className ?? ''} ${el.id ?? ''}`;
  if (/wrong|incorrect|mistake/i.test(nodeStr)) {
    return true;
  }

  // Contains an explanation text element
  for (const sel of SELECTORS.explanationText) {
    try {
      if (el.matches(sel) || el.querySelector(sel)) {
        return true;
      }
    } catch {
      // Invalid selector — skip
    }
  }

  return false;
}

function isWrongMoveAttributeChange(mutation: MutationRecord, el: Element): boolean {
  if (mutation.attributeName === 'class') {
    const className = el.className ?? '';
    if (className.includes('icon--wrong') || /wrong|incorrect|mistake/i.test(className)) {
      return true;
    }
  }

  if (mutation.attributeName === 'data-state' || mutation.attributeName === 'aria-hidden') {
    if (el.matches?.('[data-testid="moveNotification"]') ||
        el.closest?.('[data-testid="moveNotification"]')) {
      return true;
    }
  }

  return false;
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

const observer = new MutationObserver((mutations: MutationRecord[]) => {
  if (!settings.enabled) return;

  for (const mutation of mutations) {
    // ── Newly added nodes ──────────────────────────────────────────────────
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;

      // Skip mutations caused by our own DOM changes
      if (isOwnMutation(el)) continue;

      if (isWrongMoveTrigger(el)) {
        // For move notifications, give a tick for content to populate
        if (el.matches?.('[data-testid="moveNotification"]') ||
            el.querySelector?.('[data-testid="moveNotification"]')) {
          setTimeout(() => {
            if (isWrongMoveVisible()) {
              onWrongMoveDetected(el);
            }
          }, 100);
        } else if (isWrongMoveVisible()) {
          onWrongMoveDetected(el);
        }
        return; // One trigger per mutation batch is enough
      }
    }

    // ── Attribute changes ──────────────────────────────────────────────────
    if (mutation.type === 'attributes') {
      const el = mutation.target as Element;

      // Skip our own attribute changes
      if (isOwnMutation(el)) continue;

      if (isWrongMoveAttributeChange(mutation, el)) {
        if (isWrongMoveVisible()) {
          onWrongMoveDetected(el);
        }
        return; // One trigger per mutation batch is enough
      }
    }
  }
});

// ─── Injected panel ───────────────────────────────────────────────────────────

let panel: ReturnType<typeof createPanel> | null = null;

function initPanel(): void {
  /** Helper: update a setting, persist, broadcast, and restart speech if needed. */
  function applySpeechSetting<K extends keyof TTSSettings>(key: K, value: TTSSettings[K]): void {
    settings = { ...settings, [key]: value };
    chrome.storage.sync.set({ [key]: value });
    broadcastSettings({ [key]: value } as Partial<TTSSettings>);
    restartSpeechWithNewSettings();
  }

  panel = createPanel({
    onToggleEnabled(enabled) {
      settings.enabled = enabled;
      chrome.storage.sync.set({ enabled });
      broadcastSettings({ enabled });

      // Cancel speech immediately when disabled
      if (!enabled && state === 'speaking') {
        window.speechSynthesis.cancel();
        clearHighlights();
        resetToIdle();
      }
    },

    onRateChange(rate) {
      applySpeechSetting('rate', rate);
    },

    onPitchChange(pitch) {
      applySpeechSetting('pitch', pitch);
    },

    onVolumeChange(volume) {
      applySpeechSetting('volume', volume);
    },

    onVoiceChange(voice) {
      applySpeechSetting('voice', voice);
    },

    onReadMoveChange(on) {
      settings.readMoveFirst = on;
      chrome.storage.sync.set({ readMoveFirst: on });
      broadcastSettings({ readMoveFirst: on });
    },

    onReadExplanationChange(on) {
      settings.readExplanation = on;
      chrome.storage.sync.set({ readExplanation: on });
      broadcastSettings({ readExplanation: on });
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

    onPause() {
      window.speechSynthesis.pause();
      panel?.setPlaybackState('paused');
    },

    onResume() {
      window.speechSynthesis.resume();
      panel?.setPlaybackState('speaking');
    },

    onRestart() {
      window.speechSynthesis.cancel();
      clearHighlights();
      clearWordHighlighting(currentWordMapping);
      currentWordMapping = null;
      currentHighlightedSquare = null;
      clearKeepAlive();
      resetToIdle();

      // Re-speak the same text (moveRanges are still valid from initial doSpeak)
      if (currentRawText) {
        state = 'speaking';

        // Re-find the explanation element and set up highlighting again
        const explanationEl = findExplanationElement(null);
        if (explanationEl) {
          currentWordMapping = prepareHighlighting(explanationEl, currentRawText);
        }

        doSpeakProcessed(currentProcessedText);
      }
    },
  });

  panel.updateFromSettings(settings);
  panel.initVoiceList(settings.voice);
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
  console.log('[ChessableTTS] Observer active (state machine).');
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
  handleWrongMove:  () => onWrongMoveDetected(document.body),
  get settings() { return settings; },
  selectors: SELECTORS,
  testNotation: (text: string) => speak(text),
  get state() { return state; },
  resetState: resetToIdle,
};
