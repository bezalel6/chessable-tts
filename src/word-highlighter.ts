/**
 * word-highlighter.ts — Word-level text highlighting for Chessable TTS
 *
 * As the TTS engine speaks, this module highlights the current word in the
 * original Chessable explanation text. The challenge is that processText()
 * expands SAN tokens ("Nf3" → "Knight to f 3"), producing more words than
 * the original. This module builds a mapping between processed word indices
 * and original word spans so onboundary events can drive the highlights.
 *
 * The mapping is built from rawText (getVisibleText output) rather than
 * from live DOM words, because the DOM may contain SVG piece icons and
 * other elements that produce different word lists than the processed text.
 * A rawText→DOM alignment step bridges the two word lists.
 *
 * Lifecycle:
 *   1. prepareHighlighting(element, rawText) — wraps words in spans, builds mapping
 *   2. highlightWordByProcessedIndex(mapping, idx) — highlights current word
 *   3. clearWordHighlighting(mapping) — unwraps spans, restores original DOM
 */

import { parseMove, moveToSpeech, cleanMoveNumbers } from './chess-notation';

// ─── Constants ──────────────────────────────────────────────────────────────

const WORD_ATTR = 'data-chtts-word';
const ACTIVE_CLASS = 'chtts-word-active';
const STYLE_ID = 'chessable-tts-word-highlight-styles';

// Same SAN regex used in chess-notation.ts and board-highlighter.ts
const SAN_PATTERN =
  /^(?:\d+\.{1,3}\s*)?(?:O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#!?]*)$/;

// ─── Types ──────────────────────────────────────────────────────────────────

interface WordInfo {
  text: string;
  span: HTMLSpanElement | null;
}

export interface WordMapping {
  originalWords: WordInfo[];
  processedToOriginal: number[];
  hostElement: Element;
}

// ─── Style injection ────────────────────────────────────────────────────────

let styleInjected = false;

function ensureStyles(): void {
  if (styleInjected) return;
  if (document.getElementById(STYLE_ID)) {
    styleInjected = true;
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${WORD_ATTR}] {
      transition: background-color 0.05s ease;
      border-radius: 2px;
    }
    .${ACTIVE_CLASS} {
      background-color: rgba(200, 169, 110, 0.4) !important;
      box-shadow: 0 0 0 1px rgba(200, 169, 110, 0.3);
    }
  `;
  document.head.appendChild(style);
  styleInjected = true;
}

// ─── Text node word splitting ───────────────────────────────────────────────

/**
 * Split text into word tokens and whitespace segments.
 * Returns alternating [word, space, word, space, ...] segments.
 * Words are non-whitespace runs; spaces are whitespace runs.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const regex = /(\S+|\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    tokens.push(m[0]);
  }
  return tokens;
}

/** Extract just the word tokens (non-whitespace) from a string. */
function extractWords(text: string): string[] {
  return text.match(/\S+/g) ?? [];
}

// ─── Raw-to-DOM alignment ───────────────────────────────────────────────────

/**
 * Build a mapping from rawText word indices to DOM word indices.
 *
 * rawText comes from getVisibleText() which clones the DOM and transforms it
 * (replaces SVG piece icons with SAN letters, strips .openingNum divs, etc.).
 * The DOM words come from the live TreeWalker over the actual element.
 *
 * Uses greedy forward matching: walks both lists in parallel, matching equal
 * words. On mismatch, scans ahead in the DOM list to find a match (handles
 * cases where SVG→letter substitution produces different tokens).
 */
function buildRawToDomMap(rawWords: string[], domWords: string[]): number[] {
  const map: number[] = [];
  let domIdx = 0;

  for (let rawIdx = 0; rawIdx < rawWords.length; rawIdx++) {
    const rawWord = rawWords[rawIdx];
    if (rawWord === undefined) {
      map.push(-1);
      continue;
    }

    // Try exact match at current domIdx
    if (domIdx < domWords.length && domWords[domIdx] === rawWord) {
      map.push(domIdx);
      domIdx++;
      continue;
    }

    // Scan ahead in DOM words (max 5 steps) for a match
    let found = false;
    for (let ahead = 1; ahead <= 5 && domIdx + ahead < domWords.length; ahead++) {
      if (domWords[domIdx + ahead] === rawWord) {
        domIdx = domIdx + ahead;
        map.push(domIdx);
        domIdx++;
        found = true;
        break;
      }
    }

    if (!found) {
      // No match — map to current domIdx as best effort and advance
      if (domIdx < domWords.length) {
        map.push(domIdx);
        domIdx++;
      } else {
        map.push(-1);
      }
    }
  }

  return map;
}

// ─── Core functions ─────────────────────────────────────────────────────────

/**
 * Prepare word-level highlighting on a DOM element.
 *
 * 1. Walks text nodes in the element and wraps each word in a span
 * 2. Builds processedWordIndex → originalWordIndex mapping from rawText
 *    (getVisibleText output), NOT from DOM words — this prevents desync
 *    caused by DOM→text transformations (SVG pieces, stripped move numbers)
 * 3. Chains: processedIdx → rawTextIdx → domIdx → highlight span
 *
 * Returns null if the element has no usable text.
 */
export function prepareHighlighting(
  element: Element,
  rawText: string,
): WordMapping | null {
  ensureStyles();

  const originalWords: WordInfo[] = [];
  let wordIndex = 0;

  // Collect text nodes via TreeWalker
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.trim().length > 0) {
      textNodes.push(node);
    }
  }

  if (textNodes.length === 0) return null;

  // Collect DOM words before wrapping (for alignment)
  const domWordTexts: string[] = [];
  for (const textNode of textNodes) {
    const words = extractWords(textNode.textContent ?? '');
    domWordTexts.push(...words);
  }

  // Process each text node: split into words and wrap each in a span
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    if (!text) continue;

    const tokens = tokenize(text);
    if (tokens.length === 0) continue;

    const frag = document.createDocumentFragment();

    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        frag.appendChild(document.createTextNode(token));
      } else {
        const span = document.createElement('span');
        span.setAttribute(WORD_ATTR, String(wordIndex));
        span.textContent = token;
        frag.appendChild(span);

        originalWords.push({ text: token, span });
        wordIndex++;
      }
    }

    textNode.parentNode?.replaceChild(frag, textNode);
  }

  if (originalWords.length === 0) return null;

  // Build mapping from rawText words (which match processed text) to DOM words
  const cleanedRawText = cleanMoveNumbers(rawText);
  const rawWords = extractWords(cleanedRawText);
  const rawToDom = buildRawToDomMap(rawWords, domWordTexts);

  // Build processedToOriginal from rawText words (not DOM words)
  // This ensures the mapping matches what processTextWithMoveMap produces
  const processedToOriginal: number[] = [];

  for (let rawIdx = 0; rawIdx < rawWords.length; rawIdx++) {
    const word = rawWords[rawIdx];
    if (word === undefined) continue;

    const domIdx = rawToDom[rawIdx] ?? -1;
    const cleanWord = word.replace(/^[.,;:!?()[\]{}"""\u2018\u2019]+|[.,;:!?()[\]{}"""\u2018\u2019]+$/g, '');

    // Check if this word is a SAN move token
    if (SAN_PATTERN.test(cleanWord)) {
      const parsed = parseMove(cleanWord);
      if (parsed) {
        const spoken = moveToSpeech(parsed);
        const spokenWordCount = spoken.split(/\s+/).filter(Boolean).length;
        // This single raw word maps to N processed words, all pointing to the same DOM span
        for (let j = 0; j < spokenWordCount; j++) {
          processedToOriginal.push(domIdx >= 0 ? domIdx : rawIdx);
        }
        continue;
      }
    }

    // Non-SAN word: 1:1 mapping
    processedToOriginal.push(domIdx >= 0 ? domIdx : rawIdx);
  }

  return {
    originalWords,
    processedToOriginal,
    hostElement: element,
  };
}

/**
 * Highlight the original word corresponding to the given processed word index.
 */
export function highlightWordByProcessedIndex(
  mapping: WordMapping,
  processedWordIdx: number,
): void {
  // Remove previous active highlight
  const prevActive = mapping.hostElement.querySelector(`.${ACTIVE_CLASS}`);
  if (prevActive) {
    prevActive.classList.remove(ACTIVE_CLASS);
  }

  const originalIdx = mapping.processedToOriginal[processedWordIdx];
  if (originalIdx === undefined) return;

  const wordInfo = mapping.originalWords[originalIdx];
  if (!wordInfo?.span) return;

  wordInfo.span.classList.add(ACTIVE_CLASS);
}

/**
 * Remove all word highlighting spans, restoring the original text nodes.
 */
export function clearWordHighlighting(mapping: WordMapping | null): void {
  if (!mapping) return;

  // Find all word spans and unwrap them
  const spans = mapping.hostElement.querySelectorAll(`[${WORD_ATTR}]`);
  spans.forEach((span) => {
    const text = document.createTextNode(span.textContent ?? '');
    span.parentNode?.replaceChild(text, span);
  });

  // Normalize adjacent text nodes back together
  mapping.hostElement.normalize();

  // Clear span references
  for (const word of mapping.originalWords) {
    word.span = null;
  }
}
