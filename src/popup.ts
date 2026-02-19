/**
 * popup.ts — Chessable TTS Popup
 *
 * Manages the extension's settings UI. Changes are persisted to chrome.storage.sync
 * and broadcast to any active Chessable tabs.
 */

import { DEFAULT_SETTINGS, ExtensionMessage, TTSSettings } from './types';

// ─── Element helpers ──────────────────────────────────────────────────────────

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[ChessableTTS Popup] Missing element: #${id}`);
  return el as T;
}

// ─── Control references ───────────────────────────────────────────────────────

const controls = {
  enabled:         getEl<HTMLInputElement>('toggleEnabled'),
  voice:           getEl<HTMLSelectElement>('voiceSelect'),
  rate:            getEl<HTMLInputElement>('rateSlider'),
  pitch:           getEl<HTMLInputElement>('pitchSlider'),
  volume:          getEl<HTMLInputElement>('volumeSlider'),
  rateVal:         getEl<HTMLSpanElement>('rateVal'),
  pitchVal:        getEl<HTMLSpanElement>('pitchVal'),
  volumeVal:       getEl<HTMLSpanElement>('volumeVal'),
  readMove:        getEl<HTMLInputElement>('checkReadMove'),
  readExplanation: getEl<HTMLInputElement>('checkReadExplanation'),
  btnTest:         getEl<HTMLButtonElement>('btnTest'),
  statusDot:       getEl<HTMLSpanElement>('statusDot'),
  statusText:      getEl<HTMLSpanElement>('statusText'),
} as const;

// ─── Voice population ─────────────────────────────────────────────────────────

function populateVoices(savedVoice: string): void {
  const voices = speechSynthesis.getVoices();
  const select = controls.voice;

  // Remove all options except the first default placeholder
  while (select.options.length > 1) select.remove(1);

  voices.forEach((v) => {
    const opt = document.createElement('option');
    opt.value       = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    if (v.name === savedVoice) opt.selected = true;
    select.appendChild(opt);
  });
}

speechSynthesis.onvoiceschanged = () => {
  chrome.storage.sync.get(['voice'], ({ voice }) => {
    populateVoices((voice as string) ?? '');
  });
};
populateVoices('');

// ─── Load persisted settings ──────────────────────────────────────────────────

chrome.storage.sync.get(
  Object.keys(DEFAULT_SETTINGS) as (keyof TTSSettings)[],
  (stored: Partial<TTSSettings>) => {
    if (stored.enabled  !== undefined) controls.enabled.checked  = stored.enabled;
    if (stored.rate     !== undefined) controls.rate.value        = String(stored.rate);
    if (stored.pitch    !== undefined) controls.pitch.value       = String(stored.pitch);
    if (stored.volume   !== undefined) controls.volume.value      = String(stored.volume);
    if (stored.readMoveFirst    !== undefined) controls.readMove.checked        = stored.readMoveFirst;
    if (stored.readExplanation  !== undefined) controls.readExplanation.checked = stored.readExplanation;

    updateDisplayValues();
    updateStatus();
    populateVoices(stored.voice ?? '');
  },
);

// ─── Display helpers ──────────────────────────────────────────────────────────

function updateDisplayValues(): void {
  controls.rateVal.textContent   = `${parseFloat(controls.rate.value).toFixed(1)}×`;
  controls.pitchVal.textContent  = parseFloat(controls.pitch.value).toFixed(1);
  controls.volumeVal.textContent = `${Math.round(parseFloat(controls.volume.value) * 100)}%`;
}

function updateStatus(): void {
  const on = controls.enabled.checked;
  document.body.classList.toggle('disabled', !on);
  controls.statusDot.classList.toggle('off', !on);
  controls.statusText.textContent = on ? 'Active on Chessable' : 'TTS is disabled';
}

// ─── Settings serialisation ───────────────────────────────────────────────────

function readSettings(): TTSSettings {
  return {
    enabled:         controls.enabled.checked,
    rate:            parseFloat(controls.rate.value),
    pitch:           parseFloat(controls.pitch.value),
    volume:          parseFloat(controls.volume.value),
    voice:           controls.voice.value,
    readMoveFirst:   controls.readMove.checked,
    readExplanation: controls.readExplanation.checked,
  };
}

// ─── Save & broadcast ─────────────────────────────────────────────────────────

function saveAndBroadcast(): void {
  const settings = readSettings();
  chrome.storage.sync.set(settings);

  const msg: ExtensionMessage = { type: 'SETTINGS_UPDATED', settings };

  chrome.tabs.query({ url: 'https://www.chessable.com/*' }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {
          // Tab may not have content script injected yet — silently ignore
        });
      }
    });
  });
}

// ─── Debounce helper ─────────────────────────────────────────────────────────

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

const debouncedSave = debounce(saveAndBroadcast, 150);

// ─── Event listeners ──────────────────────────────────────────────────────────

controls.enabled.addEventListener('change', () => {
  updateStatus();
  saveAndBroadcast();
});

([controls.rate, controls.pitch, controls.volume] as HTMLInputElement[]).forEach((slider) => {
  slider.addEventListener('input', () => {
    updateDisplayValues();
    debouncedSave();
  });
});

controls.voice.addEventListener('change', saveAndBroadcast);
controls.readMove.addEventListener('change', saveAndBroadcast);
controls.readExplanation.addEventListener('change', saveAndBroadcast);

// ─── Test button ──────────────────────────────────────────────────────────────

controls.btnTest.addEventListener('click', () => {
  const testMsg: ExtensionMessage = { type: 'TEST_SPEAK' };

  chrome.tabs.query({ url: 'https://www.chessable.com/*', active: true }, (tabs) => {
    const firstTab = tabs[0];
    if (firstTab !== undefined && firstTab.id !== undefined) {
      chrome.tabs.sendMessage(firstTab.id, testMsg).catch(() => fallbackSpeak());
    } else {
      fallbackSpeak();
    }
  });
});

function fallbackSpeak(): void {
  const s = readSettings();
  const u = new SpeechSynthesisUtterance(
    'Knight to f 3 check. This move attacks the queen and forks the rook.',
  );
  u.rate   = s.rate;
  u.pitch  = s.pitch;
  u.volume = s.volume;

  if (s.voice) {
    const match = speechSynthesis.getVoices().find((v) => v.name === s.voice);
    if (match) u.voice = match;
  }

  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
