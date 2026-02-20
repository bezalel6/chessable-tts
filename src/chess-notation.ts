/**
 * chess-notation.ts
 * Converts standard algebraic chess notation (SAN) into natural spoken English.
 *
 * Examples:
 *   "Nf3"     → "Knight to f 3"
 *   "Bxe5+"   → "Bishop takes e 5 check"
 *   "O-O-O"   → "Queenside castle"
 *   "exd5"    → "e pawn takes d 5"
 *   "e8=Q"    → "pawn to e 8, promotes to Queen"
 *   "Nbd7"    → "Knight on b to d 7"
 *   "R1e4"    → "Rook on 1 to e 4"
 *   "Rxd8#"   → "Rook takes d 8 checkmate"
 */

import type { File, MoveRange, ParsedMove, PieceLetter, Rank, Square } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PIECE_NAMES: Record<PieceLetter, string> = {
  K: 'King',
  Q: 'Queen',
  R: 'Rook',
  B: 'Bishop',
  N: 'Knight',
};

/**
 * Speak a square like "e4" → "e 4".
 * Separating the file letter and rank number prevents TTS engines from
 * mispronouncing them as words (e.g. "e4" read as "four" or "e-four").
 */
function speakSquare(square: string): string {
  return square.split('').join(' ');
}

// ─── Single move parser ───────────────────────────────────────────────────────

/**
 * Parse one SAN move token and return a {@link ParsedMove} object,
 * or null if the token cannot be recognized as a chess move.
 */
export function parseMove(token: string): ParsedMove | null {
  if (!token) return null;

  let move = token.trim();

  // Strip move-number prefix: "1.", "12.", "1...", "12..."
  move = move.replace(/^\d+\.+\s*/, '');

  // ── Suffix detection (check / checkmate) ──────────────────────────────────
  let isCheck = false;
  let isDoubleCheck = false;
  let isCheckmate = false;

  if (move.endsWith('#')) {
    isCheckmate = true;
    move = move.slice(0, -1);
  } else if (move.endsWith('++')) {
    isDoubleCheck = true;
    move = move.slice(0, -2);
  } else if (move.endsWith('+')) {
    isCheck = true;
    move = move.slice(0, -1);
  }

  // Strip annotation noise: !, ?, !?, ?!
  move = move.replace(/[!?]+$/, '');

  // ── Castling ──────────────────────────────────────────────────────────────
  if (move === 'O-O-O' || move === '0-0-0') {
    return {
      piece: null, fromFile: null, fromRank: null,
      isCapture: false, toSquare: 'g8' as Square,
      promotionPiece: null,
      isCheck, isDoubleCheck, isCheckmate,
      isCastleKingside: false, isCastleQueenside: true,
    };
  }
  if (move === 'O-O' || move === '0-0') {
    return {
      piece: null, fromFile: null, fromRank: null,
      isCapture: false, toSquare: 'g8' as Square,
      promotionPiece: null,
      isCheck, isDoubleCheck, isCheckmate,
      isCastleKingside: true, isCastleQueenside: false,
    };
  }

  // ── Promotion ─────────────────────────────────────────────────────────────
  let promotionPiece: PieceLetter | null = null;
  const promoMatch = move.match(/=?([QRBN])$/);
  if (promoMatch) {
    const beforePromo = move.slice(0, move.length - promoMatch[0].length);
    if (/[1-8]$/.test(beforePromo)) {
      promotionPiece = promoMatch[1] as PieceLetter;
      move = beforePromo;
    }
  }

  // ── Standard algebraic notation ───────────────────────────────────────────
  // Format: [Piece][fromFile?][fromRank?][x?][toFile][toRank]
  const pattern = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])$/;
  const m = move.match(pattern);
  if (!m) return null;

  const [, rawPiece, rawFromFile, rawFromRank, rawCapture, rawToSquare] = m;

  return {
    piece:            (rawPiece as PieceLetter) ?? null,
    fromFile:         (rawFromFile as File) ?? null,
    fromRank:         (rawFromRank as Rank) ?? null,
    isCapture:        !!rawCapture,
    toSquare:         rawToSquare as Square,
    promotionPiece,
    isCheck,
    isDoubleCheck,
    isCheckmate,
    isCastleKingside:  false,
    isCastleQueenside: false,
  };
}

// ─── Move → spoken text ───────────────────────────────────────────────────────

/**
 * Convert a {@link ParsedMove} to a natural English spoken string.
 */
export function moveToSpeech(parsed: ParsedMove): string {
  const parts: string[] = [];

  // ── Castling ──────────────────────────────────────────────────────────────
  if (parsed.isCastleQueenside) {
    parts.push('Queenside castle');
  } else if (parsed.isCastleKingside) {
    parts.push('Kingside castle');
  } else {
    // ── Piece or pawn ──────────────────────────────────────────────────────
    if (parsed.piece) {
      parts.push(PIECE_NAMES[parsed.piece]);
    } else {
      // Pawn — include disambiguating file if it's a capture
      if (parsed.fromFile && parsed.isCapture) {
        parts.push(`${parsed.fromFile} pawn`);
      } else {
        parts.push('pawn');
      }
    }

    // ── Disambiguation for pieces (Nbd7, R1e4) ────────────────────────────
    if (parsed.piece && (parsed.fromFile || parsed.fromRank)) {
      const disambig = (parsed.fromFile ?? '') + (parsed.fromRank ?? '');
      parts.push(`on ${speakSquare(disambig)}`);
    }

    // ── Verb ──────────────────────────────────────────────────────────────
    parts.push(parsed.isCapture ? 'takes' : 'to');

    // ── Destination ───────────────────────────────────────────────────────
    parts.push(speakSquare(parsed.toSquare));

    // ── Promotion ─────────────────────────────────────────────────────────
    if (parsed.promotionPiece) {
      parts.push(`promotes to ${PIECE_NAMES[parsed.promotionPiece]}`);
    }
  }

  // ── Check / checkmate suffix ──────────────────────────────────────────────
  if (parsed.isCheckmate)    parts.push('checkmate');
  else if (parsed.isDoubleCheck) parts.push('double check');
  else if (parsed.isCheck)   parts.push('check');

  return parts.join(' ');
}

// ─── Move pattern ──────────────────────────────────────────────────────────────

/**
 * Regex that matches move tokens inside prose.
 * Matches (in order of priority):
 *   - Castling:    O-O-O | O-O | 0-0-0 | 0-0
 *   - SAN moves:   [KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#!?]*
 *   - Plain pawn:  [a-h][2-7]  (single-step pawn moves like "e4")
 *
 * Optional move-number prefix (e.g. "1." or "12...") is included so
 * we can strip it in parseMove without leaving orphaned numbers.
 *
 * Trailing \b removed — +, #, !, ? are non-word chars so \b fails after them.
 * The pattern is specific enough that removing the trailing boundary is safe.
 */
export const MOVE_PATTERN =
  /\b(?:\d+\.{1,3}\s*)?(?:O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#!?]*)/g;

// ─── Text processor ───────────────────────────────────────────────────────────

/**
 * Process a full prose string, finding every SAN move token and replacing it
 * with its spoken equivalent. Non-move text is left untouched.
 */
export function processText(text: string): string {
  if (!text) return text;

  MOVE_PATTERN.lastIndex = 0;
  return text.replace(MOVE_PATTERN, (match) => {
    const parsed = parseMove(match);
    if (!parsed) return match;
    const spoken = moveToSpeech(parsed);
    return spoken || match;
  });
}

// ─── Text processor with move range mapping ──────────────────────────────────

/**
 * Process a full prose string like {@link processText}, but also return
 * a mapping of where each move's spoken text falls in the output string.
 * This allows callers to highlight board squares in sync with speech.
 *
 * Castling moves are excluded from moveRanges (no clear destination square).
 */
export function processTextWithMoveMap(text: string): {
  processed: string;
  moveRanges: MoveRange[];
} {
  if (!text) return { processed: text, moveRanges: [] };

  const moveRanges: MoveRange[] = [];
  let result = '';
  let lastIndex = 0;

  MOVE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MOVE_PATTERN.exec(text)) !== null) {
    const parsed = parseMove(match[0]);
    if (!parsed) {
      // Not a valid move — keep original text
      continue;
    }

    const spoken = moveToSpeech(parsed);
    if (!spoken) continue;

    // Append everything before this match (unchanged)
    result += text.slice(lastIndex, match.index);

    const charStart = result.length;
    result += spoken;
    const charEnd = result.length;

    // Record the range for non-castling moves
    if (!parsed.isCastleKingside && !parsed.isCastleQueenside) {
      moveRanges.push({
        charStart,
        charEnd,
        square: parsed.toSquare,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Append any remaining text after the last match
  result += text.slice(lastIndex);

  return { processed: result, moveRanges };
}
