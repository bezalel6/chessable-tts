/**
 * debug-overlay.ts — Visual debug overlay for Chessable TTS
 *
 * Highlights DOM elements that the extension detects, color-coded by category:
 *   - Red:    wrong move indicators
 *   - Blue:   explanation text blocks
 *   - Green:  move notation elements
 *   - Yellow: comment containers
 *
 * Toggled on/off via the injected panel or popup debug setting.
 * Uses a periodic scan (every 2s) to keep highlights current as Chessable's
 * SPA updates the DOM.
 */

import type { SelectorGroup } from './types';

// ─── Category config ────────────────────────────────────────────────────────

interface HighlightCategory {
  key: keyof SelectorGroup;
  label: string;
  color: string;         // border / outline color
  bgTint: string;        // semi-transparent background tint
}

const CATEGORIES: HighlightCategory[] = [
  { key: 'wrongMoveIndicator', label: 'Wrong',       color: '#e53935', bgTint: 'rgba(229,57,53,0.08)' },
  { key: 'wrongMoveContainer', label: 'WrongBox',    color: '#e57373', bgTint: 'rgba(229,115,115,0.06)' },
  { key: 'explanationText',    label: 'Explanation',  color: '#42a5f5', bgTint: 'rgba(66,165,245,0.08)' },
  { key: 'moveNotation',       label: 'Notation',     color: '#66bb6a', bgTint: 'rgba(102,187,106,0.08)' },
  { key: 'commentContainer',   label: 'Comment',      color: '#fdd835', bgTint: 'rgba(253,216,53,0.08)' },
];

// ─── Style tag ──────────────────────────────────────────────────────────────

const STYLE_ID = 'chessable-tts-debug-styles';

function getOrCreateStyleTag(): HTMLStyleElement {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  return style;
}

function buildCSS(): string {
  const rules: string[] = [];

  for (const cat of CATEGORIES) {
    rules.push(`
      .chtts-debug-${cat.key} {
        outline: 2px solid ${cat.color} !important;
        background-color: ${cat.bgTint} !important;
        position: relative;
      }
    `);
  }

  // Floating label shared styles
  rules.push(`
    .chtts-debug-label {
      position: absolute;
      top: -18px;
      left: 2px;
      font-size: 10px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-weight: 600;
      line-height: 1;
      padding: 2px 5px;
      border-radius: 3px;
      z-index: 999999;
      pointer-events: none;
      white-space: nowrap;
    }
  `);

  for (const cat of CATEGORIES) {
    rules.push(`
      .chtts-debug-label-${cat.key} {
        background: ${cat.color};
        color: #fff;
      }
    `);
  }

  return rules.join('\n');
}

// ─── Highlight / cleanup logic ──────────────────────────────────────────────

const HIGHLIGHT_ATTR = 'data-chtts-debug';
const LABEL_CLASS = 'chtts-debug-label';

function removeAllHighlights(): void {
  // Remove highlight classes and labels
  const highlighted = document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`);
  highlighted.forEach((el) => {
    const cats = (el.getAttribute(HIGHLIGHT_ATTR) ?? '').split(',');
    for (const catKey of cats) {
      el.classList.remove(`chtts-debug-${catKey}`);
    }
    el.removeAttribute(HIGHLIGHT_ATTR);
  });

  // Remove all labels
  document.querySelectorAll(`.${LABEL_CLASS}`).forEach((l) => l.remove());
}

function applyHighlights(selectors: SelectorGroup): void {
  for (const cat of CATEGORIES) {
    const sels = selectors[cat.key];
    for (const sel of sels) {
      let els: NodeListOf<Element>;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }

      els.forEach((el) => {
        // Track which categories this element belongs to
        const existing = el.getAttribute(HIGHLIGHT_ATTR);
        const cats = existing ? existing.split(',') : [];

        if (!cats.includes(cat.key)) {
          cats.push(cat.key);
          el.setAttribute(HIGHLIGHT_ATTR, cats.join(','));
          el.classList.add(`chtts-debug-${cat.key}`);

          // Add floating label if this element doesn't already have one for this category
          if (!el.querySelector(`.chtts-debug-label-${cat.key}`)) {
            // Only add label if element has some dimensions
            const htmlEl = el as HTMLElement;
            if (htmlEl.offsetWidth > 0 || htmlEl.offsetHeight > 0) {
              const label = document.createElement('span');
              label.className = `${LABEL_CLASS} chtts-debug-label-${cat.key}`;
              label.textContent = cat.label;

              // If element doesn't have relative/absolute/fixed positioning, we need
              // to make labels work. The outline + class already sets position:relative.
              el.appendChild(label);
            }
          }
        }
      });
    }
  }
}

// ─── Periodic scan ──────────────────────────────────────────────────────────

let scanInterval: ReturnType<typeof setInterval> | null = null;
let currentSelectors: SelectorGroup | null = null;

function startScanning(selectors: SelectorGroup): void {
  currentSelectors = selectors;
  // Initial scan
  removeAllHighlights();
  applyHighlights(selectors);

  // Re-scan every 2 seconds to pick up SPA changes
  if (scanInterval !== null) clearInterval(scanInterval);
  scanInterval = setInterval(() => {
    if (currentSelectors) {
      removeAllHighlights();
      applyHighlights(currentSelectors);
    }
  }, 2000);
}

function stopScanning(): void {
  if (scanInterval !== null) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  removeAllHighlights();
  currentSelectors = null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

let isActive = false;

export function enableOverlay(selectors: SelectorGroup): void {
  if (isActive) return;
  isActive = true;

  const style = getOrCreateStyleTag();
  style.textContent = buildCSS();
  startScanning(selectors);

  console.log('[ChessableTTS] Debug overlay enabled');
}

export function disableOverlay(): void {
  if (!isActive) return;
  isActive = false;

  stopScanning();
  const style = document.getElementById(STYLE_ID);
  if (style) style.textContent = '';

  console.log('[ChessableTTS] Debug overlay disabled');
}

export function toggleOverlay(selectors: SelectorGroup): boolean {
  if (isActive) {
    disableOverlay();
  } else {
    enableOverlay(selectors);
  }
  return isActive;
}

export function isOverlayActive(): boolean {
  return isActive;
}
