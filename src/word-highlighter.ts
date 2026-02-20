/**
 * word-highlighter.ts — Word-level text highlighting for Chessable TTS
 *
 * As the TTS engine speaks, this module highlights the current word in the
 * original Chessable explanation text. The challenge is that processText()
 * expands SAN tokens ("Nf3" → "Knight to f 3"), producing more words than
 * the original. This module builds a mapping between processed word indices
 * and original word spans so onboundary events can drive the highlights.
 *
 * Lifecycle:
 *   1. prepareHighlighting(element, originalText) — wraps words in spans, builds mapping
 *   2. highlightWordByProcessedIndex(mapping, idx) — highlights current word
 *   3. clearWordHighlighting(mapping) — unwraps spans, restores original DOM
 */

import { parseMove, moveToSpeech } from './chess-notation';

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
      transition: background-color 0.15s ease;
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

// ─── Core functions ─────────────────────────────────────────────────────────

/**
 * Prepare word-level highlighting on a DOM element.
 *
 * 1. Walks text nodes in the element
 * 2. Wraps each word in a <span data-chtts-word="N">
 * 3. Builds a processedWordIndex → originalWordIndex mapping
 *
 * Returns null if the element has no usable text.
 */
export function prepareHighlighting(
  element: Element,
  _originalText: string,
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

  // Process each text node: split into words and wrap each in a span
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    if (!text) continue;

    const tokens = tokenize(text);
    if (tokens.length === 0) continue;

    // Create a document fragment to replace the text node
    const frag = document.createDocumentFragment();

    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        // Whitespace — keep as a text node
        frag.appendChild(document.createTextNode(token));
      } else {
        // Word — wrap in a span
        const span = document.createElement('span');
        span.setAttribute(WORD_ATTR, String(wordIndex));
        span.textContent = token;
        frag.appendChild(span);

        originalWords.push({ text: token, span });
        wordIndex++;
      }
    }

    // Replace the original text node with the fragment
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  if (originalWords.length === 0) return null;

  // Build the processedToOriginal mapping
  const processedToOriginal: number[] = [];

  for (let i = 0; i < originalWords.length; i++) {
    const word = originalWords[i];
    if (!word) continue;

    const cleanWord = word.text.replace(/^[.,;:!?()[\]{}"""'']+|[.,;:!?()[\]{}"""'']+$/g, '');

    // Check if this word is a SAN move token
    if (SAN_PATTERN.test(cleanWord)) {
      const parsed = parseMove(cleanWord);
      if (parsed) {
        const spoken = moveToSpeech(parsed);
        const spokenWordCount = spoken.split(/\s+/).filter(Boolean).length;
        // This single original word maps to N processed words
        for (let j = 0; j < spokenWordCount; j++) {
          processedToOriginal.push(i);
        }
        continue;
      }
    }

    // Non-SAN word: 1:1 mapping
    processedToOriginal.push(i);
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

  // Scroll into view if needed
  wordInfo.span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
