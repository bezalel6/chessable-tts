/**
 * panel.ts — Injected floating control panel for Chessable TTS
 *
 * A small draggable panel fixed to the bottom-right of the Chessable page.
 * Provides quick controls without needing to open the extension popup.
 *
 * Controls:
 *   - Enable/disable toggle (syncs with chrome.storage.sync)
 *   - Volume slider
 *   - "Read current" button — reads currently visible explanation text
 *   - Debug overlay toggle
 *   - Collapse/expand button
 *
 * All styles are scoped inside a shadow DOM to avoid conflicts with Chessable.
 */

import type { TTSSettings } from './types';

// ─── Callbacks ──────────────────────────────────────────────────────────────

export interface PanelCallbacks {
  onToggleEnabled: (enabled: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onReadCurrent: () => void;
  onToggleDebug: (debugOn: boolean) => void;
}

// ─── Panel class ────────────────────────────────────────────────────────────

export class ControlPanel {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private collapsed = false;
  private callbacks: PanelCallbacks;

  // Element refs inside shadow
  private toggleInput!: HTMLInputElement;
  private volumeSlider!: HTMLInputElement;
  private volumeVal!: HTMLSpanElement;
  private debugInput!: HTMLInputElement;
  private panelBody!: HTMLDivElement;
  private collapseBtn!: HTMLButtonElement;
  private statusDot!: HTMLSpanElement;

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
        <span class="panel-logo">♟</span>
        <span class="panel-title">TTS</span>
        <span class="status-dot on" data-ref="statusDot"></span>
        <button class="collapse-btn" data-ref="collapseBtn" title="Collapse">−</button>
      </div>
      <div class="panel-body" data-ref="panelBody">
        <div class="control-row">
          <span class="label">Enabled</span>
          <label class="switch">
            <input type="checkbox" data-ref="toggleInput" checked />
            <span class="switch-track"></span>
          </label>
        </div>
        <div class="control-row">
          <span class="label">Volume</span>
          <input type="range" class="vol-slider" data-ref="volumeSlider"
                 min="0" max="1" step="0.05" value="1" />
          <span class="vol-val" data-ref="volumeVal">100%</span>
        </div>
        <div class="control-row">
          <button class="btn-read" data-ref="readBtn">Read Current</button>
        </div>
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
    this.toggleInput  = this.ref<HTMLInputElement>(wrapper, 'toggleInput');
    this.volumeSlider = this.ref<HTMLInputElement>(wrapper, 'volumeSlider');
    this.volumeVal    = this.ref<HTMLSpanElement>(wrapper, 'volumeVal');
    this.debugInput   = this.ref<HTMLInputElement>(wrapper, 'debugInput');
    this.panelBody    = this.ref<HTMLDivElement>(wrapper, 'panelBody');
    this.collapseBtn  = this.ref<HTMLButtonElement>(wrapper, 'collapseBtn');
    this.statusDot    = this.ref<HTMLSpanElement>(wrapper, 'statusDot');

    const readBtn = this.ref<HTMLButtonElement>(wrapper, 'readBtn');

    // Event listeners
    this.toggleInput.addEventListener('change', () => {
      const on = this.toggleInput.checked;
      this.statusDot.className = on ? 'status-dot on' : 'status-dot off';
      this.callbacks.onToggleEnabled(on);
    });

    this.volumeSlider.addEventListener('input', () => {
      const vol = parseFloat(this.volumeSlider.value);
      this.volumeVal.textContent = `${Math.round(vol * 100)}%`;
      this.callbacks.onVolumeChange(vol);
    });

    readBtn.addEventListener('click', () => {
      this.callbacks.onReadCurrent();
    });

    this.debugInput.addEventListener('change', () => {
      this.callbacks.onToggleDebug(this.debugInput.checked);
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
    this.collapseBtn.textContent = this.collapsed ? '+' : '−';
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

  /** Sync panel controls with current settings */
  updateFromSettings(settings: TTSSettings): void {
    this.toggleInput.checked  = settings.enabled;
    this.volumeSlider.value   = String(settings.volume);
    this.volumeVal.textContent = `${Math.round(settings.volume * 100)}%`;
    this.debugInput.checked   = settings.debugMode;
    this.statusDot.className  = settings.enabled ? 'status-dot on' : 'status-dot off';
  }

  setDebugChecked(on: boolean): void {
    this.debugInput.checked = on;
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
        width: 220px;
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
        gap: 10px;
      }

      .control-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .label {
        font-size: 11px;
        color: #7a7470;
        min-width: 50px;
        flex-shrink: 0;
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

      /* ── Volume slider ── */
      .vol-slider {
        flex: 1;
        -webkit-appearance: none;
        appearance: none;
        height: 3px;
        background: #2e2c29;
        border-radius: 3px;
        outline: none;
        cursor: pointer;
      }
      .vol-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        background: #c8a96e;
        border-radius: 50%;
        cursor: pointer;
      }

      .vol-val {
        font-size: 10px;
        color: #c8a96e;
        min-width: 28px;
        text-align: right;
        font-family: monospace;
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
