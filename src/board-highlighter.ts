/**
 * board-highlighter.ts — Board square highlighting for Chessable TTS
 *
 * Highlights squares on the Chessable chessboard as moves are being read aloud.
 * Finds squares via [data-square] attributes and injects overlay divs with
 * a pulsing gold tint animation.
 *
 * Board DOM structure (from Chessable):
 *   <div data-square="e4" class="square-55d63 ... square-e4"> ... </div>
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const OVERLAY_ATTR = 'data-chtts-highlight';
const STYLE_ID = 'chessable-tts-board-highlight-styles';

const HIGHLIGHT_COLOR = 'rgba(200, 169, 110, 0.45)';
const HIGHLIGHT_PULSE_COLOR = 'rgba(200, 169, 110, 0.2)';

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
    @keyframes chtts-square-pulse {
      0%, 100% { background-color: ${HIGHLIGHT_COLOR}; }
      50%      { background-color: ${HIGHLIGHT_PULSE_COLOR}; }
    }

    [${OVERLAY_ATTR}] {
      position: absolute !important;
      inset: 0 !important;
      z-index: 5 !important;
      pointer-events: none !important;
      animation: chtts-square-pulse 1.2s ease-in-out infinite !important;
      border-radius: 2px !important;
    }
  `;
  document.head.appendChild(style);
  styleInjected = true;
}

// ─── Square lookup ──────────────────────────────────────────────────────────

function findSquareElement(square: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-square="${square}"]`);
}

// ─── Highlight / clear ──────────────────────────────────────────────────────

/**
 * Highlight a single square on the board with a pulsing overlay.
 * Injects styles on first call. Safe to call multiple times for the same square.
 */
export function highlightSquare(square: string): void {
  ensureStyles();

  const squareEl = findSquareElement(square);
  if (!squareEl) return;

  // Don't double-highlight
  if (squareEl.querySelector(`[${OVERLAY_ATTR}]`)) return;

  // Ensure the square has relative positioning for the overlay
  const computed = window.getComputedStyle(squareEl);
  if (computed.position === 'static') {
    squareEl.style.position = 'relative';
  }

  const overlay = document.createElement('div');
  overlay.setAttribute(OVERLAY_ATTR, square);
  squareEl.appendChild(overlay);
}

export function clearHighlights(): void {
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove());
}
