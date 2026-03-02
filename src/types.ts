// ─── Settings ─────────────────────────────────────────────────────────────────

export interface TTSSettings {
  enabled: boolean;
  rate: number;       // 0.5 – 2.0
  pitch: number;      // 0.5 – 2.0
  volume: number;     // 0.0 – 1.0
  voice: string;      // SpeechSynthesisVoice.name, or '' for default
  readMoveFirst: boolean;
  readExplanation: boolean;
}

export const DEFAULT_SETTINGS: TTSSettings = {
  enabled: true,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  voice: '',
  readMoveFirst: true,
  readExplanation: true,
};

// ─── Messages (popup ↔ content script) ────────────────────────────────────────

export type PlaybackState = 'idle' | 'speaking' | 'paused';

export type ExtensionMessage =
  | { type: 'SETTINGS_UPDATED'; settings: Partial<TTSSettings> }
  | { type: 'TEST_SPEAK' }
  | { type: 'READ_CURRENT' }
  | { type: 'PAUSE_SPEECH' }
  | { type: 'RESUME_SPEECH' }
  | { type: 'RESTART_SPEECH' }
  | { type: 'GET_PLAYBACK_STATE' }
  | { type: 'PLAYBACK_STATE_CHANGED'; state: PlaybackState };

// ─── Chess notation types ──────────────────────────────────────────────────────

export type PieceLetter = 'K' | 'Q' | 'R' | 'B' | 'N';
export type File = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';
export type Rank = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';
export type Square = `${File}${Rank}`;

export interface ParsedMove {
  piece: PieceLetter | null;   // null = pawn
  fromFile: File | null;
  fromRank: Rank | null;
  isCapture: boolean;
  toSquare: Square;
  promotionPiece: PieceLetter | null;
  isCheck: boolean;
  isDoubleCheck: boolean;
  isCheckmate: boolean;
  isCastleKingside: boolean;
  isCastleQueenside: boolean;
}

// ─── Move range mapping (for timed board highlighting) ──────────────────────────

export interface MoveRange {
  charStart: number;
  charEnd: number;
  square: string;
}

// ─── DOM selector groups ───────────────────────────────────────────────────────

export interface SelectorGroup {
  wrongMoveContainer: string[];
  explanationText: string[];
  wrongMoveIndicator: string[];
  moveNotation: string[];
  commentContainer: string[];
}

// ─── TTS state machine ──────────────────────────────────────────────────────

export type TTSState = 'idle' | 'detecting' | 'speaking' | 'cooldown';

// ─── Debug API exposed on window ──────────────────────────────────────────────

export interface ChessableTTSDebug {
  speak: (text: string) => void;
  handleWrongMove: () => void;
  settings: TTSSettings;
  selectors: SelectorGroup;
  testNotation: (text: string) => void;
  state: TTSState;
  resetState: () => void;
}

declare global {
  interface Window {
    __chessableTTS: ChessableTTSDebug;
  }
}
