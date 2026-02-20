/**
 * panel.ts — Injected floating control panel for Chessable TTS
 *
 * A small draggable panel fixed to the bottom-right of the Chessable page.
 * Provides quick controls without needing to open the extension popup.
 *
 * Controls:
 *   - Enable/disable toggle
 *   - Rate, pitch, volume sliders
 *   - Voice selector
 *   - "Read current" button + playback controls (pause/restart)
 *   - Read move / read explanation checkboxes
 *   - Debug overlay toggle
 *   - Collapse/expand button
 *
 * All styles are scoped inside a shadow DOM to avoid conflicts with Chessable.
 */

import type { PlaybackState, TTSSettings } from './types';

// ─── Callbacks ──────────────────────────────────────────────────────────────

export interface PanelCallbacks {
  onToggleEnabled: (enabled: boolean) => void;
  onRateChange: (rate: number) => void;
  onPitchChange: (pitch: number) => void;
  onVolumeChange: (volume: number) => void;
  onVoiceChange: (voice: string) => void;
  onReadMoveChange: (on: boolean) => void;
  onReadExplanationChange: (on: boolean) => void;
  onReadCurrent: () => void;
  onToggleDebug: (debugOn: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
}

// ─── Panel class ────────────────────────────────────────────────────────────

export class ControlPanel {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private collapsed = false;
  private callbacks: PanelCallbacks;

  // Element refs inside shadow
  private toggleInput!: HTMLInputElement;
  private rateSlider!: HTMLInputElement;
  private rateVal!: HTMLSpanElement;
  private pitchSlider!: HTMLInputElement;
  private pitchVal!: HTMLSpanElement;
  private volumeSlider!: HTMLInputElement;
  private volumeVal!: HTMLSpanElement;
  private voiceSelect!: HTMLSelectElement;
  private readMoveInput!: HTMLInputElement;
  private readExplanationInput!: HTMLInputElement;
  private debugInput!: HTMLInputElement;
  private panelBody!: HTMLDivElement;
  private collapseBtn!: HTMLButtonElement;
  private statusDot!: HTMLSpanElement;
  private pauseBtn!: HTMLButtonElement;
  private restartBtn!: HTMLButtonElement;
  private playbackState: PlaybackState = 'idle';

  // Drag state
  private isDragging = false;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor(callbacks: PanelCallbacks) {
    this.callbacks = callbacks;

    // Create the host element
    this.host = document.createElement('div');
    this.host.id = 'chessable-tts-panel';
    this.host.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999998;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    `;

    // Create shadow DOM
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    this.buildPanel();
    this.setupDrag();
    this.populateVoices();
  }

  // ─── Build DOM ──────────────────────────────────────────────────────────

  private buildPanel(): void {
    const style = document.createElement('style');
    style.textContent = this.getStyles();
    this.shadow.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.className = 'panel';
    wrapper.innerHTML = `
      <div class="panel-header" data-drag-handle>
        <span class="panel-logo">\u265F</span>
        <span class="panel-title">TTS</span>
        <span class="status-dot on" data-ref="statusDot"></span>
        <button class="collapse-btn" data-ref="collapseBtn" title="Collapse">\u2212</button>
      </div>
      <div class="panel-body" data-ref="panelBody">
        <div class="control-row">
          <span class="label">Enabled</span>
          <label class="switch">
            <input type="checkbox" data-ref="toggleInput" checked />
            <span class="switch-track"></span>
          </label>
        </div>

        <div class="separator"></div>

        <div class="control-row">
          <span class="label">Speed</span>
          <input type="range" class="slider" data-ref="rateSlider"
                 min="0.5" max="2" step="0.05" value="1" />
          <span class="slider-val" data-ref="rateVal">1.0\u00d7</span>
        </div>
        <div class="control-row">
          <span class="label">Pitch</span>
          <input type="range" class="slider" data-ref="pitchSlider"
                 min="0.5" max="2" step="0.05" value="1" />
          <span class="slider-val" data-ref="pitchVal">1.0</span>
        </div>
        <div class="control-row">
          <span class="label">Volume</span>
          <input type="range" class="slider" data-ref="volumeSlider"
                 min="0" max="1" step="0.05" value="1" />
          <span class="slider-val" data-ref="volumeVal">100%</span>
        </div>
        <div class="control-row">
          <span class="label">Voice</span>
          <select data-ref="voiceSelect" class="voice-select">
            <option value="">Default</option>
          </select>
        </div>

        <div class="separator"></div>

        <div class="control-row">
          <label class="check-row">
            <input type="checkbox" data-ref="readMoveInput" checked />
            <span class="check-box"></span>
            <span class="check-label">Read move</span>
          </label>
        </div>
        <div class="control-row">
          <label class="check-row">
            <input type="checkbox" data-ref="readExplanationInput" checked />
            <span class="check-box"></span>
            <span class="check-label">Read explanation</span>
          </label>
        </div>

        <div class="separator"></div>

        <div class="control-row">
          <button class="btn-read" data-ref="readBtn">Read Current</button>
        </div>
        <div class="control-row playback-row">
          <button class="btn-playback" data-ref="pauseBtn" disabled title="Pause">\u23F8</button>
          <button class="btn-playback" data-ref="restartBtn" disabled title="Restart">\u21BA</button>
        </div>

        <div class="separator"></div>

        <div class="control-row">
          <span class="label">Debug</span>
          <label class="switch">
            <input type="checkbox" data-ref="debugInput" />
            <span class="switch-track"></span>
          </label>
        </div>
      </div>
    `;

    this.shadow.appendChild(wrapper);

    // Bind refs
    this.toggleInput         = this.ref<HTMLInputElement>(wrapper, 'toggleInput');
    this.rateSlider          = this.ref<HTMLInputElement>(wrapper, 'rateSlider');
    this.rateVal             = this.ref<HTMLSpanElement>(wrapper, 'rateVal');
    this.pitchSlider         = this.ref<HTMLInputElement>(wrapper, 'pitchSlider');
    this.pitchVal            = this.ref<HTMLSpanElement>(wrapper, 'pitchVal');
    this.volumeSlider        = this.ref<HTMLInputElement>(wrapper, 'volumeSlider');
    this.volumeVal           = this.ref<HTMLSpanElement>(wrapper, 'volumeVal');
    this.voiceSelect         = this.ref<HTMLSelectElement>(wrapper, 'voiceSelect');
    this.readMoveInput       = this.ref<HTMLInputElement>(wrapper, 'readMoveInput');
    this.readExplanationInput = this.ref<HTMLInputElement>(wrapper, 'readExplanationInput');
    this.debugInput          = this.ref<HTMLInputElement>(wrapper, 'debugInput');
    this.panelBody           = this.ref<HTMLDivElement>(wrapper, 'panelBody');
    this.collapseBtn         = this.ref<HTMLButtonElement>(wrapper, 'collapseBtn');
    this.statusDot           = this.ref<HTMLSpanElement>(wrapper, 'statusDot');
    this.pauseBtn            = this.ref<HTMLButtonElement>(wrapper, 'pauseBtn');
    this.restartBtn          = this.ref<HTMLButtonElement>(wrapper, 'restartBtn');

    const readBtn = this.ref<HTMLButtonElement>(wrapper, 'readBtn');

    // ── Event listeners ──────────────────────────────────────────────────

    this.toggleInput.addEventListener('change', () => {
      const on = this.toggleInput.checked;
      this.statusDot.className = on ? 'status-dot on' : 'status-dot off';
      this.callbacks.onToggleEnabled(on);
    });

    this.rateSlider.addEventListener('input', () => {
      const rate = parseFloat(this.rateSlider.value);
      this.rateVal.textContent = `${rate.toFixed(1)}\u00d7`;
      this.callbacks.onRateChange(rate);
    });

    this.pitchSlider.addEventListener('input', () => {
      const pitch = parseFloat(this.pitchSlider.value);
      this.pitchVal.textContent = pitch.toFixed(1);
      this.callbacks.onPitchChange(pitch);
    });

    this.volumeSlider.addEventListener('input', () => {
      const vol = parseFloat(this.volumeSlider.value);
      this.volumeVal.textContent = `${Math.round(vol * 100)}%`;
      this.callbacks.onVolumeChange(vol);
    });

    this.voiceSelect.addEventListener('change', () => {
      this.callbacks.onVoiceChange(this.voiceSelect.value);
    });

    this.readMoveInput.addEventListener('change', () => {
      this.callbacks.onReadMoveChange(this.readMoveInput.checked);
    });

    this.readExplanationInput.addEventListener('change', () => {
      this.callbacks.onReadExplanationChange(this.readExplanationInput.checked);
    });

    readBtn.addEventListener('click', () => {
      this.callbacks.onReadCurrent();
    });

    this.debugInput.addEventListener('change', () => {
      this.callbacks.onToggleDebug(this.debugInput.checked);
    });

    this.pauseBtn.addEventListener('click', () => {
      if (this.playbackState === 'speaking') {
        this.callbacks.onPause();
      } else if (this.playbackState === 'paused') {
        this.callbacks.onResume();
      }
    });

    this.restartBtn.addEventListener('click', () => {
      this.callbacks.onRestart();
    });

    this.collapseBtn.addEventListener('click', () => {
      this.toggleCollapse();
    });
  }

  private ref<T extends HTMLElement>(root: HTMLElement, name: string): T {
    const el = root.querySelector(`[data-ref="${name}"]`);
    if (!el) throw new Error(`[ChessableTTS Panel] Missing ref: ${name}`);
    return el as T;
  }

  // ─── Voice population ────────────────────────────────────────────────

  private populateVoices(savedVoice = ''): void {
    const voices = window.speechSynthesis.getVoices();

    // Clear all options except the default
    while (this.voiceSelect.options.length > 1) {
      this.voiceSelect.remove(1);
    }

    for (const v of voices) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.name === savedVoice) opt.selected = true;
      this.voiceSelect.appendChild(opt);
    }
  }

  /** Re-populate voices when the browser has loaded them async. */
  initVoiceList(savedVoice: string): void {
    this.populateVoices(savedVoice);

    // Voices may load asynchronously — listen for the event
    window.speechSynthesis.onvoiceschanged = () => {
      this.populateVoices(savedVoice);
    };
  }

  // ─── Drag ───────────────────────────────────────────────────────────────

  private setupDrag(): void {
    const handle = this.shadow.querySelector('[data-drag-handle]') as HTMLElement | null;
    if (!handle) return;

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      // Don't start drag if clicking on a button inside the header
      if ((e.target as HTMLElement).closest('button')) return;

      this.isDragging = true;
      const rect = this.host.getBoundingClientRect();
      this.dragOffsetX = e.clientX - rect.left;
      this.dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.isDragging) return;
      const x = e.clientX - this.dragOffsetX;
      const y = e.clientY - this.dragOffsetY;
      this.host.style.left   = `${x}px`;
      this.host.style.top    = `${y}px`;
      this.host.style.right  = 'auto';
      this.host.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }

  // ─── Collapse/expand ──────────────────────────────────────────────────

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.panelBody.style.display = this.collapsed ? 'none' : '';
    this.collapseBtn.textContent = this.collapsed ? '+' : '\u2212';
    this.collapseBtn.title = this.collapsed ? 'Expand' : 'Collapse';
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  mount(): void {
    if (!document.body.contains(this.host)) {
      document.body.appendChild(this.host);
    }
  }

  unmount(): void {
    this.host.remove();
  }

  /** Sync all panel controls with current settings */
  updateFromSettings(s: TTSSettings): void {
    this.toggleInput.checked           = s.enabled;
    this.rateSlider.value              = String(s.rate);
    this.rateVal.textContent           = `${s.rate.toFixed(1)}\u00d7`;
    this.pitchSlider.value             = String(s.pitch);
    this.pitchVal.textContent          = s.pitch.toFixed(1);
    this.volumeSlider.value            = String(s.volume);
    this.volumeVal.textContent         = `${Math.round(s.volume * 100)}%`;
    this.readMoveInput.checked         = s.readMoveFirst;
    this.readExplanationInput.checked  = s.readExplanation;
    this.debugInput.checked            = s.debugMode;
    this.statusDot.className           = s.enabled ? 'status-dot on' : 'status-dot off';

    // Voice: set value if it's in the list, otherwise leave on default
    this.voiceSelect.value = s.voice;
  }

  setDebugChecked(on: boolean): void {
    this.debugInput.checked = on;
  }

  setPlaybackState(state: PlaybackState): void {
    this.playbackState = state;
    switch (state) {
      case 'idle':
        this.pauseBtn.disabled = true;
        this.restartBtn.disabled = true;
        this.pauseBtn.textContent = '\u23F8';
        this.pauseBtn.title = 'Pause';
        break;
      case 'speaking':
        this.pauseBtn.disabled = false;
        this.restartBtn.disabled = false;
        this.pauseBtn.textContent = '\u23F8';
        this.pauseBtn.title = 'Pause';
        break;
      case 'paused':
        this.pauseBtn.disabled = false;
        this.restartBtn.disabled = false;
        this.pauseBtn.textContent = '\u25B6';
        this.pauseBtn.title = 'Resume';
        break;
    }
  }

  // ─── Styles ──────────────────────────────────────────────────────────────

  private getStyles(): string {
    return `
      :host {
        all: initial;
      }

      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      .panel {
        width: 230px;
        background: #0f0e0d;
        border: 1px solid #2e2c29;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        font-size: 12px;
        color: #e8e4dc;
        user-select: none;
      }

      .panel-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        background: #1a1917;
        border-bottom: 1px solid #2e2c29;
        cursor: grab;
      }
      .panel-header:active { cursor: grabbing; }

      .panel-logo {
        width: 20px;
        height: 20px;
        background: #c8a96e;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
      }

      .panel-title {
        font-weight: 600;
        font-size: 12px;
        color: #c8a96e;
        flex: 1;
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .status-dot.on {
        background: #4caf82;
        box-shadow: 0 0 6px #4caf82;
      }
      .status-dot.off {
        background: #7a7470;
        box-shadow: none;
      }

      .collapse-btn {
        width: 20px;
        height: 20px;
        background: transparent;
        border: 1px solid #2e2c29;
        border-radius: 4px;
        color: #7a7470;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .collapse-btn:hover {
        border-color: #c8a96e;
        color: #c8a96e;
      }

      .panel-body {
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 420px;
        overflow-y: auto;
      }

      .control-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .label {
        font-size: 11px;
        color: #7a7470;
        min-width: 46px;
        flex-shrink: 0;
      }

      .separator {
        height: 1px;
        background: #2e2c29;
        margin: 2px 0;
      }

      /* ── Toggle switch ── */
      .switch {
        position: relative;
        width: 32px;
        height: 17px;
        flex-shrink: 0;
        margin-left: auto;
      }
      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
      }
      .switch-track {
        position: absolute;
        inset: 0;
        background: #2e2c29;
        border-radius: 17px;
        cursor: pointer;
        transition: background 0.2s;
      }
      .switch-track::after {
        content: '';
        position: absolute;
        width: 11px;
        height: 11px;
        left: 3px;
        top: 3px;
        background: #fff;
        border-radius: 50%;
        transition: transform 0.2s;
      }
      .switch input:checked + .switch-track { background: #c8a96e; }
      .switch input:checked + .switch-track::after { transform: translateX(15px); }

      /* ── Sliders ── */
      .slider {
        flex: 1;
        -webkit-appearance: none;
        appearance: none;
        height: 3px;
        background: #2e2c29;
        border-radius: 3px;
        outline: none;
        cursor: pointer;
      }
      .slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        background: #c8a96e;
        border-radius: 50%;
        cursor: pointer;
      }

      .slider-val {
        font-size: 10px;
        color: #c8a96e;
        min-width: 28px;
        text-align: right;
        font-family: monospace;
      }

      /* ── Voice select ── */
      .voice-select {
        flex: 1;
        min-width: 0;
        background: #1a1917;
        border: 1px solid #2e2c29;
        color: #e8e4dc;
        padding: 4px 6px;
        border-radius: 4px;
        font-family: inherit;
        font-size: 10px;
        outline: none;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }
      .voice-select:focus { border-color: #c8a96e; }

      /* ── Checkbox rows ── */
      .check-row {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 11px;
      }
      .check-row input[type=checkbox] { display: none; }
      .check-box {
        width: 14px;
        height: 14px;
        border: 1.5px solid #2e2c29;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: border-color 0.15s, background 0.15s;
      }
      .check-row input:checked ~ .check-box {
        background: #c8a96e;
        border-color: #c8a96e;
      }
      .check-row input:checked ~ .check-box::after {
        content: '';
        display: block;
        width: 8px;
        height: 4px;
        border-left: 1.5px solid #0f0e0d;
        border-bottom: 1.5px solid #0f0e0d;
        transform: translateY(-1px) rotate(-45deg);
      }
      .check-label {
        color: #7a7470;
      }

      /* ── Read button ── */
      .btn-read {
        flex: 1;
        padding: 6px 10px;
        background: transparent;
        border: 1px solid #2e2c29;
        border-radius: 6px;
        color: #7a7470;
        font-family: inherit;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: border-color 0.15s, color 0.15s;
      }
      .btn-read:hover {
        border-color: #c8a96e;
        color: #c8a96e;
      }
      .btn-read:active { opacity: 0.7; }

      /* ── Playback controls ── */
      .playback-row {
        gap: 6px;
        justify-content: center;
      }

      .btn-playback {
        flex: 1;
        padding: 6px 10px;
        background: transparent;
        border: 1px solid #2e2c29;
        border-radius: 6px;
        color: #7a7470;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: border-color 0.15s, color 0.15s;
      }
      .btn-playback:hover:not(:disabled) {
        border-color: #c8a96e;
        color: #c8a96e;
      }
      .btn-playback:active:not(:disabled) { opacity: 0.7; }
      .btn-playback:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    `;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

let panelInstance: ControlPanel | null = null;

export function createPanel(callbacks: PanelCallbacks): ControlPanel {
  if (panelInstance) return panelInstance;

  panelInstance = new ControlPanel(callbacks);
  return panelInstance;
}

export function getPanel(): ControlPanel | null {
  return panelInstance;
}
