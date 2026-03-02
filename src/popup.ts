/**
 * popup.ts — Chessable TTS Popup
 *
 * Manages the extension's settings UI and playback controls. Settings changes
 * are persisted to chrome.storage.sync and sent as partial updates to content
 * scripts. Playback state is received from content scripts and reflected in
 * the UI.
 */

import { DEFAULT_SETTINGS, ExtensionMessage, PlaybackState, TTSSettings } from './types';

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
  btnReadCurrent:  getEl<HTMLButtonElement>('btnReadCurrent'),
  btnPauseResume:  getEl<HTMLButtonElement>('btnPauseResume'),
  btnRestart:      getEl<HTMLButtonElement>('btnRestart'),
  pauseResumeIcon: getEl<HTMLSpanElement>('pauseResumeIcon'),
  pauseResumeLabel: getEl<HTMLSpanElement>('pauseResumeLabel'),
  statusDot:       getEl<HTMLSpanElement>('statusDot'),
  statusText:      getEl<HTMLSpanElement>('statusText'),
} as const;

// ─── Playback state ──────────────────────────────────────────────────────────

let currentPlaybackState: PlaybackState = 'idle';

function updatePlaybackUI(pbState: PlaybackState): void {
  currentPlaybackState = pbState;

  switch (pbState) {
    case 'idle':
      controls.btnPauseResume.disabled = true;
      controls.btnRestart.disabled = true;
      controls.pauseResumeIcon.textContent = '\u23F8';
      controls.pauseResumeLabel.textContent = 'Pause';
      break;
    case 'speaking':
      controls.btnPauseResume.disabled = false;
      controls.btnRestart.disabled = false;
      controls.pauseResumeIcon.textContent = '\u23F8';
      controls.pauseResumeLabel.textContent = 'Pause';
      break;
    case 'paused':
      controls.btnPauseResume.disabled = false;
      controls.btnRestart.disabled = false;
      controls.pauseResumeIcon.textContent = '\u25B6';
      controls.pauseResumeLabel.textContent = 'Resume';
      break;
  }
}

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
  controls.rateVal.textContent   = `${parseFloat(controls.rate.value).toFixed(1)}\u00d7`;
  controls.pitchVal.textContent  = parseFloat(controls.pitch.value).toFixed(1);
  controls.volumeVal.textContent = `${Math.round(parseFloat(controls.volume.value) * 100)}%`;
}

function updateStatus(): void {
  const on = controls.enabled.checked;
  document.body.classList.toggle('disabled', !on);

  // Only update the base status if we're not reflecting playback state
  if (currentPlaybackState === 'idle') {
    controls.statusDot.className = on ? 'status-dot' : 'status-dot off';
    controls.statusText.textContent = on ? 'Active on Chessable' : 'TTS is disabled';
  }
}

function updateStatusFromPlayback(pbState: PlaybackState): void {
  if (!controls.enabled.checked) return;

  switch (pbState) {
    case 'idle':
      controls.statusDot.className = 'status-dot';
      controls.statusText.textContent = 'Active on Chessable';
      break;
    case 'speaking':
      controls.statusDot.className = 'status-dot speaking';
      controls.statusText.textContent = 'Speaking...';
      break;
    case 'paused':
      controls.statusDot.className = 'status-dot paused';
      controls.statusText.textContent = 'Paused';
      break;
  }
}

// ─── Tab messaging helpers ───────────────────────────────────────────────────

function sendToChessableTabs(msg: ExtensionMessage): void {
  chrome.tabs.query({ url: 'https://www.chessable.com/*' }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id !== undefined) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {
          // Tab may not have content script injected yet
        });
      }
    });
  });
}

function sendToActiveChessableTab(msg: ExtensionMessage, callback?: (response: unknown) => void): void {
  chrome.tabs.query({ url: 'https://www.chessable.com/*', active: true, currentWindow: true }, (tabs) => {
    const firstTab = tabs[0];
    if (firstTab !== undefined && firstTab.id !== undefined) {
      if (callback) {
        chrome.tabs.sendMessage(firstTab.id, msg).then(callback).catch(() => {
          // No content script
        });
      } else {
        chrome.tabs.sendMessage(firstTab.id, msg).catch(() => {
          // No content script
        });
      }
    }
  });
}

// ─── Save & send (partial updates) ──────────────────────────────────────────

function saveAndSend(partial: Partial<TTSSettings>): void {
  chrome.storage.sync.set(partial);
  sendToChessableTabs({ type: 'SETTINGS_UPDATED', settings: partial });
}

// ─── Debounce helper ─────────────────────────────────────────────────────────

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

controls.enabled.addEventListener('change', () => {
  updateStatus();
  saveAndSend({ enabled: controls.enabled.checked });
});

// Sliders — debounced partial saves
const debouncedRateSave = debounce(() => {
  saveAndSend({ rate: parseFloat(controls.rate.value) });
}, 150);

const debouncedPitchSave = debounce(() => {
  saveAndSend({ pitch: parseFloat(controls.pitch.value) });
}, 150);

const debouncedVolumeSave = debounce(() => {
  saveAndSend({ volume: parseFloat(controls.volume.value) });
}, 150);

controls.rate.addEventListener('input', () => {
  updateDisplayValues();
  debouncedRateSave();
});

controls.pitch.addEventListener('input', () => {
  updateDisplayValues();
  debouncedPitchSave();
});

controls.volume.addEventListener('input', () => {
  updateDisplayValues();
  debouncedVolumeSave();
});

controls.voice.addEventListener('change', () => {
  saveAndSend({ voice: controls.voice.value });
});

controls.readMove.addEventListener('change', () => {
  saveAndSend({ readMoveFirst: controls.readMove.checked });
});

controls.readExplanation.addEventListener('change', () => {
  saveAndSend({ readExplanation: controls.readExplanation.checked });
});

// ─── Playback controls ──────────────────────────────────────────────────────

controls.btnReadCurrent.addEventListener('click', () => {
  sendToActiveChessableTab({ type: 'READ_CURRENT' });
});

controls.btnPauseResume.addEventListener('click', () => {
  if (currentPlaybackState === 'speaking') {
    sendToActiveChessableTab({ type: 'PAUSE_SPEECH' });
  } else if (currentPlaybackState === 'paused') {
    sendToActiveChessableTab({ type: 'RESUME_SPEECH' });
  }
});

controls.btnRestart.addEventListener('click', () => {
  sendToActiveChessableTab({ type: 'RESTART_SPEECH' });
});

// ─── Test button ──────────────────────────────────────────────────────────────

controls.btnTest.addEventListener('click', () => {
  sendToActiveChessableTab({ type: 'TEST_SPEAK' });
  // Fallback: if no Chessable tab is active, speak locally
  chrome.tabs.query({ url: 'https://www.chessable.com/*', active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) fallbackSpeak();
  });
});

function fallbackSpeak(): void {
  const rate   = parseFloat(controls.rate.value);
  const pitch  = parseFloat(controls.pitch.value);
  const volume = parseFloat(controls.volume.value);
  const voice  = controls.voice.value;

  const u = new SpeechSynthesisUtterance(
    'Knight to f 3 check. This move attacks the queen and forks the rook.',
  );
  u.rate   = rate;
  u.pitch  = pitch;
  u.volume = volume;

  if (voice) {
    const match = speechSynthesis.getVoices().find((v) => v.name === voice);
    if (match) u.voice = match;
  }

  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ─── Incoming messages from content script ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
  if (msg.type === 'PLAYBACK_STATE_CHANGED') {
    updatePlaybackUI(msg.state);
    updateStatusFromPlayback(msg.state);
  }
});

// ─── Storage change listener (reactive UI sync) ─────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes['enabled'] !== undefined) {
    controls.enabled.checked = changes['enabled'].newValue as boolean;
    updateStatus();
  }
  if (changes['rate'] !== undefined) {
    controls.rate.value = String(changes['rate'].newValue);
    updateDisplayValues();
  }
  if (changes['pitch'] !== undefined) {
    controls.pitch.value = String(changes['pitch'].newValue);
    updateDisplayValues();
  }
  if (changes['volume'] !== undefined) {
    controls.volume.value = String(changes['volume'].newValue);
    updateDisplayValues();
  }
  if (changes['voice'] !== undefined) {
    controls.voice.value = changes['voice'].newValue as string;
  }
  if (changes['readMoveFirst'] !== undefined) {
    controls.readMove.checked = changes['readMoveFirst'].newValue as boolean;
  }
  if (changes['readExplanation'] !== undefined) {
    controls.readExplanation.checked = changes['readExplanation'].newValue as boolean;
  }
});

// ─── Query playback state on popup open ──────────────────────────────────────

sendToActiveChessableTab(
  { type: 'GET_PLAYBACK_STATE' },
  (response) => {
    const resp = response as { state?: PlaybackState } | undefined;
    if (resp?.state) {
      updatePlaybackUI(resp.state);
      updateStatusFromPlayback(resp.state);
    }
  },
);
