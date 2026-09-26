'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WsClient } = require('./ws');
const { ObsClient, OBS_DIR } = require('./obs');

const ACTIONS = {
  'com.ijuantm.clipmanager.game': { key: 'game', hotkey: 'hk_game_toggle' },
  'com.ijuantm.clipmanager.display': { key: 'display', hotkey: 'hk_display_toggle' },
  'com.ijuantm.clipmanager.mic': { key: 'mic', hotkey: 'hk_toggle_mic' },
  'com.ijuantm.clipmanager.listen': { key: 'listen', hotkey: 'hk_toggle_monitor' },
  'com.ijuantm.clipmanager.save': { key: 'save' },
};
const IMAGE_DIR = path.join(__dirname, '..', 'imgs', 'keys');
const POLL_MS = 1000;
const SPINNER_FRAMES = 12;
const SPINNER_MS = 90;
const MIN_PRESS_MS = 150;
const FLASH_MS = 1500;
const NAME_RETRY_MS = 10000;
const NAME_EVENTS = new Set([
  'CurrentSceneCollectionChanged',
  'InputCreated',
  'InputRemoved',
  'InputNameChanged',
]);

const args = {};
for (let i = 2; i < process.argv.length - 1; i += 2) args[process.argv[i].replace(/^-/, '')] = process.argv[i + 1];

const sd = new WsClient(`ws://127.0.0.1:${args.port}`);
const obs = new ObsClient(log);
const keys = new Map(); // context -> { key, hotkey, last, pressedAt, pressed, flash, flashTimer }
const images = new Map();

let state = { game: 'off', display: false, mic: false, listen: false, buffer: false };
let names = null;
let namesResolvedAt = 0;
let namesSuspect = false;
let refreshing = false;
let refreshQueued = false;
let refreshTimer = null;
let spinnerTimer = null;
let spinnerFrame = 0;

function log(message) {
  sd.send(JSON.stringify({ event: 'logMessage', payload: { message: `[clipmanager] ${message}` } }));
}

function sendToDeck(event, context, payload) {
  sd.send(JSON.stringify({ event, context, payload }));
}

function loadImage(name) {
  if (!images.has(name)) {
    const file = path.join(IMAGE_DIR, `${name}@2x.png`);
    images.set(name, fs.existsSync(file) ? `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` : null);
  }
  return images.get(name);
}

function stateImage(key) {
  if (obs.status === 'disabled') return `${key}-wsoff`;
  if (obs.status !== 'ready') return `${key}-offline`;
  switch (key) {
    case 'game':
      if (state.game === 'connecting') return `game-connecting-${String(spinnerFrame).padStart(2, '0')}`;
      return `game-${state.game}`;
    case 'save':
      return state.buffer ? 'save-ready' : 'save-inactive';
    default:
      if (state[key] === null) return `${key}-missing`;
      return `${key}-${state[key] ? 'on' : 'off'}`;
  }
}

function render(context) {
  const entry = keys.get(context);
  if (!entry) return;
  let name = entry.flash ?? stateImage(entry.key);
  if (entry.pressed && loadImage(`${name}-pressed`)) name = `${name}-pressed`;
  const image = loadImage(name);
  if (entry.last === name || !image) return;
  entry.last = name;
  sendToDeck('setImage', context, { image, target: 0 });
}

function renderAll() {
  for (const context of keys.keys()) render(context);
  updateSpinner();
}

function updateSpinner() {
  const spinning =
    obs.status === 'ready' && state.game === 'connecting' && [...keys.values()].some((e) => e.key === 'game');
  if (spinning && !spinnerTimer) {
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES;
      for (const [context, entry] of keys) if (entry.key === 'game') render(context);
    }, SPINNER_MS);
  } else if (!spinning && spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

function flash(key, name) {
  for (const [context, entry] of keys) {
    if (entry.key !== key) continue;
    clearTimeout(entry.flashTimer);
    entry.flash = name;
    render(context);
    entry.flashTimer = setTimeout(() => {
      entry.flash = null;
      render(context);
    }, FLASH_MS);
  }
}

// Source names come from Clip Manager's own saved settings, so the keys track exactly the sources the script toggles.
function namesFromScriptSettings(collectionName) {
  const dir = path.join(OBS_DIR, 'basic', 'scenes');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (doc.name !== collectionName) continue;
    const script = (doc.modules?.['scripts-tool'] ?? []).find((m) => /clip_manager\.py$/i.test(m.path ?? ''));
    if (script?.settings) {
      const s = script.settings;
      return { game: s.game_source_name, display: s.desktop_source_name, mic: s.mic_source_name };
    }
  }
  return {};
}

async function resolveNames() {
  const { currentSceneCollectionName } = await obs.request('GetSceneCollectionList');
  let fromScript = {};
  try {
    fromScript = namesFromScriptSettings(currentSceneCollectionName);
  } catch (err) {
    log(`could not read Clip Manager settings: ${err.message}`);
  }
  const { inputs } = await obs.request('GetInputList');
  const firstOfKind = (kind) => inputs.find((i) => (i.unversionedInputKind ?? i.inputKind) === kind)?.inputName ?? '';
  const resolved = {
    game: fromScript.game || firstOfKind('game_capture'),
    display: fromScript.display || firstOfKind('monitor_capture'),
    mic: fromScript.mic || firstOfKind('wasapi_input_capture'),
  };
  log(`sources: game='${resolved.game}' display='${resolved.display}' mic='${resolved.mic}'`);
  return resolved;
}

async function readState() {
  if (!names || (namesSuspect && Date.now() - namesResolvedAt > NAME_RETRY_MS)) {
    names = await resolveNames();
    namesResolvedAt = Date.now();
    namesSuspect = false;
  }
  const optional = (promise) => promise.catch(() => null);
  const mic = names.mic ? { inputName: names.mic } : null;
  const [sceneItems, mute, monitor, buffer] = await Promise.all([
    obs
      .request('GetCurrentProgramScene')
      .then((scene) => obs.request('GetSceneItemList', { sceneName: scene.currentProgramSceneName ?? scene.sceneName }))
      .then((r) => r.sceneItems),
    mic && optional(obs.request('GetInputMute', mic)),
    mic && optional(obs.request('GetInputAudioMonitorType', mic)),
    optional(obs.request('GetReplayBufferStatus')),
  ]);
  const item = (name) => (name ? sceneItems.find((i) => i.sourceName === name) : undefined);
  const game = item(names.game);
  const display = item(names.display);
  const next = {
    // Hook in progress = source shown by the script but OBS has no frame yet.
    game: !game ? 'missing' : !game.sceneItemEnabled ? 'off' : game.sceneItemTransform?.sourceWidth > 0 ? 'live' : 'connecting',
    display: display ? display.sceneItemEnabled : null,
    mic: mute ? !mute.inputMuted : null,
    listen: monitor ? monitor.monitorType !== 'OBS_MONITORING_TYPE_NONE' : null,
    buffer: Boolean(buffer?.outputActive),
  };
  if (!game || !display || next.mic === null) namesSuspect = true;
  return next;
}

async function refresh() {
  if (keys.size === 0) return;
  if (obs.status !== 'ready') return renderAll();
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    state = await readState();
  } catch (err) {
    log(`refresh failed: ${err.message}`);
  } finally {
    refreshing = false;
  }
  renderAll();
  if (refreshQueued) {
    refreshQueued = false;
    refresh();
  }
}

function scheduleRefresh(delay = 30) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

async function press(context) {
  const entry = keys.get(context);
  if (obs.status !== 'ready') return sendToDeck('showAlert', context);
  try {
    if (entry.key === 'save') {
      if (!state.buffer) return sendToDeck('showAlert', context);
      await obs.request('SaveReplayBuffer');
    } else {
      await obs.request('TriggerHotkeyByName', { hotkeyName: entry.hotkey });
    }
  } catch (err) {
    log(`${entry.key} press failed: ${err.message}`);
    if (entry.key === 'save') flash('save', 'save-failed');
    sendToDeck('showAlert', context);
  }
  scheduleRefresh(150);
}

function onDeckMessage(text) {
  const msg = JSON.parse(text);
  const { event, context } = msg;
  switch (event) {
    case 'willAppear': {
      const action = ACTIONS[msg.action];
      if (!action) return;
      keys.set(context, { ...action, last: null, pressed: false, pressedAt: 0, flash: null, flashTimer: null });
      render(context);
      scheduleRefresh();
      break;
    }
    case 'willDisappear': {
      const entry = keys.get(context);
      if (entry) clearTimeout(entry.flashTimer);
      keys.delete(context);
      updateSpinner();
      break;
    }
    case 'keyDown': {
      const entry = keys.get(context);
      if (!entry) return;
      entry.pressed = true;
      entry.pressedAt = Date.now();
      render(context);
      press(context);
      break;
    }
    case 'keyUp': {
      const entry = keys.get(context);
      if (!entry) return;
      setTimeout(() => {
        entry.pressed = false;
        render(context);
      }, Math.max(0, MIN_PRESS_MS - (Date.now() - entry.pressedAt)));
      break;
    }
    case 'systemDidWakeUp':
      obs.reconnect();
      break;
  }
}

sd.on('open', () => {
  sd.send(JSON.stringify({ event: args.registerEvent, uuid: args.pluginUUID }));
  obs.start();
  setInterval(refresh, POLL_MS);
});
sd.on('message', (text) => {
  try {
    onDeckMessage(text);
  } catch (err) {
    log(`bad message from Stream Deck: ${err.message}`);
  }
});
sd.on('close', () => process.exit(0));

obs.on('status', (status) => {
  if (status === 'ready') {
    names = null;
    refresh();
  } else {
    renderAll();
  }
});
obs.on('event', (type) => {
  if (type === 'ReplayBufferSaved') flash('save', 'save-saved');
  if (NAME_EVENTS.has(type)) names = null;
  scheduleRefresh();
});
