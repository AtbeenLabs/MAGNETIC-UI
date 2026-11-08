import { SensorHub, getSensorCapabilities } from './sensor.js';
import {
  averageVector,
  subtractVectors,
  vectorMagnitude,
  fitDirectionMapping,
  applyDirectionMapping,
  loadCalibration,
  saveCalibration,
  clearCalibration,
} from './calibration.js';
import { MagneticMotion } from './physics.js';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';

const ui = {
  modeBadge: $('#modeBadge'), modeLabel: $('#modeLabel'), sensorIndicator: $('#sensorIndicator'), sensorStateText: $('#sensorStateText'),
  sensorHeadline: $('#sensorHeadline'), sensorSubline: $('#sensorSubline'), axisX: $('#axisX'), axisY: $('#axisY'), axisZ: $('#axisZ'),
  fieldMagnitude: $('#fieldMagnitude'), deltaMagnitude: $('#deltaMagnitude'), directionReadout: $('#directionReadout'),
  intensityReadout: $('#intensityReadout'), intensityBar: $('#intensityBar'), sensorNote: $('#sensorNote'),
  startSensorButton: $('#startSensorButton'), stopSensorButton: $('#stopSensorButton'), serialButton: $('#serialButton'), bleButton: $('#bleButton'),
  motionChip: $('#motionChip'), stageVector: $('#stageVector'), motionX: $('#motionX'), motionY: $('#motionY'), springState: $('#springState'),
  forceRange: $('#forceRange'), sensitivityRange: $('#sensitivityRange'), smoothRange: $('#smoothRange'),
  forceValue: $('#forceValue'), sensitivityValue: $('#sensitivityValue'), smoothValue: $('#smoothValue'),
  invertButton: $('#invertButton'), resetButton: $('#resetButton'), calibrateButton: $('#calibrateButton'),
  calibrationState: $('#calibrationState'), calibrationHint: $('#calibrationHint'), calibrationDialog: $('#calibrationDialog'),
  captureBaselineButton: $('#captureBaselineButton'), wizardStatus: $('#wizardStatus'), cancelCalibrationButton: $('#cancelCalibrationButton'),
  demoToggleButton: $('#demoToggleButton'), heroDemoButton: $('#heroDemoButton'), demoStage: $('#demoStage'), demoTarget: $('#demoTarget'), demoHint: $('#demoHint'),
  themeInfoButton: $('#themeInfoButton'), toast: $('#toast'),
};

const capabilities = getSensorCapabilities();
let calibration = loadCalibration();
let baseline = calibration?.baseline ?? null;
let latestReading = null;
let warmupSamples = [];
let activeCapture = null;
let capturedDirections = {};
let demoActive = false;
let inverted = false;
let lastToastAt = 0;
let toastTimer = null;
let realSource = null;

const motion = new MagneticMotion({ onFrame: updateMotionReadout });
const hub = new SensorHub({
  onReading: handleSensorReading,
  onStatus: handleSensorStatus,
  onError: handleSensorError,
});

function showToast(message, kind = 'info') {
  const now = Date.now();
  if (kind === 'error' && now - lastToastAt < 1800) return;
  if (kind === 'error') lastToastAt = now;
  ui.toast.textContent = message;
  ui.toast.dataset.kind = kind;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 3400);
}

function setMode(mode) {
  const labels = { real: 'REAL SENSOR', demo: 'DEMO MODE', unsupported: 'UNSUPPORTED', ready: 'READY · NOT ACTIVE' };
  ui.modeBadge.dataset.mode = mode;
  ui.modeLabel.textContent = labels[mode] ?? labels.unsupported;
}

function setSensorStatus(state, label = '') {
  ui.sensorIndicator.dataset.state = state;
  ui.sensorStateText.textContent = label || ({ connected: 'LIVE READING', connecting: 'CONNECTING', disconnected: 'NOT CONNECTED' }[state] ?? 'NOT CONNECTED');
  ui.stopSensorButton.disabled = state !== 'connected' && state !== 'connecting';
}

function clearTelemetry() {
  ui.axisX.textContent = '—'; ui.axisY.textContent = '—'; ui.axisZ.textContent = '—';
  ui.fieldMagnitude.textContent = '— µT'; ui.deltaMagnitude.textContent = '— µT';
  ui.directionReadout.textContent = 'WAITING'; ui.intensityReadout.textContent = '0%'; ui.intensityBar.style.width = '0%';
}

function updateCalibrationUI() {
  const ready = Boolean(calibration?.matrix && calibration?.baseline);
  ui.calibrationState.textContent = ready ? 'CALIBRATED' : baseline ? 'BASELINE ONLY' : 'NOT CALIBRATED';
  ui.calibrationState.dataset.ready = String(ready);
  ui.calibrationHint.textContent = ready
    ? 'Four-point mapping saved on this device.'
    : baseline ? 'Baseline available. Capture four directions for accurate screen mapping.' : 'Connect a real sensor to begin calibration.';
  const stages = ['Baseline', 'Left', 'Right', 'Up', 'Down'];
  stages.forEach((name, index) => {
    const step = $(`#calStep${name}`);
    if (!step) return;
    step.classList.toggle('is-done', index === 0 ? Boolean(baseline) : Boolean(capturedDirections[name.toLowerCase()] || calibration?.samples?.[name.toLowerCase()]));
    step.classList.toggle('is-active', index === 0 ? !baseline : !ready && Boolean(baseline) && !capturedDirections[name.toLowerCase()]);
  });
}

function handleSensorStatus({ state, source }) {
  if (state === 'connecting') {
    realSource = source;
    ui.startSensorButton.disabled = true;
    setSensorStatus('connecting', 'WAITING FOR DATA');
    ui.sensorHeadline.textContent = 'Connection opened';
    ui.sensorSubline.textContent = 'Waiting for the first real sensor reading…';
    setMode('ready');
  } else if (state === 'connected') {
    realSource = source;
    setSensorStatus('connected');
    ui.startSensorButton.disabled = true;
  } else if (state === 'disconnected') {
    realSource = null;
    setSensorStatus('disconnected');
    ui.startSensorButton.disabled = false;
    if (!demoActive) setMode(hasAnySupportedInput() ? 'ready' : 'unsupported');
  }
}

function handleSensorError(error) {
  setSensorStatus('disconnected', 'SENSOR ERROR');
  ui.sensorHeadline.textContent = 'Sensor connection issue';
  ui.sensorSubline.textContent = error?.message || 'The sensor could not provide data.';
  ui.startSensorButton.disabled = false;
  motion.reset();
  if (!demoActive) setMode(hasAnySupportedInput() ? 'ready' : 'unsupported');
  showToast(error?.message || 'Sensor error.', 'error');
}

function hasAnySupportedInput() {
  return Boolean(capabilities.secure && (capabilities.builtInMagnetometer || capabilities.usbSerial || capabilities.bluetoothLE));
}

function directionName(vector) {
  const horizontal = Math.abs(vector.x) > 0.28;
  const vertical = Math.abs(vector.y) > 0.28;
  if (!horizontal && !vertical) return 'CENTER / LOW';
  const horizontalName = vector.x > 0 ? 'RIGHT' : 'LEFT';
  const verticalName = vector.y > 0 ? 'DOWN' : 'UP';
  if (horizontal && vertical) return `${verticalName}-${horizontalName}`;
  return horizontal ? horizontalName : verticalName;
}

function handleSensorReading(reading) {
  latestReading = { x: reading.x, y: reading.y, z: reading.z, timestamp: reading.timestamp };
  if (activeCapture) activeCapture.samples.push({ x: reading.x, y: reading.y, z: reading.z });

  if (!baseline && !calibration?.baseline) {
    warmupSamples.push({ x: reading.x, y: reading.y, z: reading.z });
    if (warmupSamples.length >= 40) {
      baseline = averageVector(warmupSamples.slice(-40));
      warmupSamples = [];
      ui.sensorHeadline.textContent = 'Ambient baseline captured';
      ui.sensorSubline.textContent = 'Move a magnet close to the device to change the measured field.';
      ui.sensorNote.textContent = 'Automatic baseline captured from the first 40 readings. Recalibrate in a magnet-free environment for best results.';
      updateCalibrationUI();
      showToast('Ambient field baseline captured. Bring a magnet near the screen.');
    }
  }

  const fieldMagnitude = vectorMagnitude(reading);
  ui.axisX.textContent = format(reading.x, 1);
  ui.axisY.textContent = format(reading.y, 1);
  ui.axisZ.textContent = format(reading.z, 1);
  ui.fieldMagnitude.textContent = `${format(fieldMagnitude, 1)} µT`;
  ui.sensorHeadline.textContent = reading.source === 'built-in' ? 'Built-in magnetometer streaming' : reading.source === 'usb-serial' ? 'USB serial sensor streaming' : 'Bluetooth LE sensor streaming';
  ui.sensorSubline.textContent = reading.kind === 'uncalibrated' ? 'Uncalibrated 3-axis field · screen reference frame' : reading.kind === 'calibrated' ? 'Calibrated 3-axis field · screen reference requested' : 'External JSON sensor · live physical readings';
  setMode('real');
  setSensorStatus('connected');

  if (!baseline) {
    ui.deltaMagnitude.textContent = 'BASELINE…';
    ui.directionReadout.textContent = 'CALIBRATING';
    motion.setTarget(0, 0, 0);
    return;
  }

  const delta = subtractVectors(reading, baseline);
  const deltaMagnitude = vectorMagnitude(delta);
  ui.deltaMagnitude.textContent = `${format(deltaMagnitude, 2)} µT`;
  let direction;
  if (calibration?.matrix) {
    direction = applyDirectionMapping(calibration.matrix, delta);
  } else {
    // Best-effort mapping from a requested screen-coordinate sensor frame; label remains explicitly approximate.
    const xyMagnitude = Math.hypot(delta.x, delta.y);
    direction = xyMagnitude > 0.45
      ? { x: delta.x / xyMagnitude, y: -delta.y / xyMagnitude }
      : { x: 0, y: 0 };
  }
  if (inverted) direction = { x: -direction.x, y: -direction.y };

  const sensitivity = Number(ui.sensitivityRange.value);
  const noiseFloor = 1.7;
  const intensity = clamp(((deltaMagnitude - noiseFloor) / 28) * sensitivity, 0, 1);
  const directionalConfidence = Math.hypot(direction.x, direction.y);
  ui.directionReadout.textContent = directionalConfidence > 0.1
    ? `${directionName(direction)}${calibration?.matrix ? '' : ' · EST.'}`
    : intensity > 0.08 ? 'FIELD CHANGE · MAP NEEDED' : 'CENTER / QUIET';
  ui.intensityReadout.textContent = `${Math.round(intensity * 100)}%`;
  ui.intensityBar.style.width = `${intensity * 100}%`;
  motion.setTarget(direction.x, direction.y, intensity * Math.min(1, directionalConfidence));
}

function updateMotionReadout(frame) {
  ui.motionX.innerHTML = `${format(frame.x, 1)} <small>px</small>`;
  ui.motionY.innerHTML = `${format(frame.y, 1)} <small>px</small>`;
  ui.springState.textContent = frame.active ? 'IN MOTION' : 'REST';
  ui.motionChip.textContent = frame.active ? 'ATTRACTING' : 'IDLE';
  ui.motionChip.dataset.active = String(frame.active);
  ui.stageVector.textContent = `X ${frame.vectorX.toFixed(2)} / Y ${frame.vectorY.toFixed(2)}`;
}

async function startBuiltInSensor() {
  if (demoActive) stopDemo();
  ui.startSensorButton.disabled = true;
  ui.sensorHeadline.textContent = 'Requesting sensor access';
  ui.sensorSubline.textContent = 'Approve the browser permission if requested.';
  try {
    await hub.startBuiltIn();
    ui.sensorNote.textContent = 'Keep a magnet away during the first 40 readings if no saved baseline exists.';
  } catch (error) {
    await hub.stop();
    ui.startSensorButton.disabled = false;
    handleSensorError(error);
  }
}

async function stopSensor() {
  await hub.stop();
  latestReading = null;
  warmupSamples = [];
  activeCapture = null;
  motion.reset();
  clearTelemetry();
  ui.sensorHeadline.textContent = 'Sensor stopped';
  ui.sensorSubline.textContent = 'No live sensor data is currently being collected.';
  ui.sensorNote.textContent = 'Stopped to release the hardware and reduce battery use.';
  ui.startSensorButton.disabled = false;
  setMode(hasAnySupportedInput() ? 'ready' : 'unsupported');
}

async function startSerial() {
  if (demoActive) stopDemo();
  try {
    await hub.connectSerial();
    showToast('USB serial opened. Waiting for JSON sensor packets…');
  } catch (error) {
    await hub.stop();
    handleSensorError(error);
  }
}

async function startBluetooth() {
  if (demoActive) stopDemo();
  try {
    await hub.connectBluetooth($('#bleService').value, $('#bleCharacteristic').value);
    showToast('Bluetooth connected. Waiting for characteristic notifications…');
  } catch (error) {
    await hub.stop();
    handleSensorError(error);
  }
}

function startDemo() {
  hub.stop().catch(() => {});
  latestReading = null;
  warmupSamples = [];
  activeCapture = null;
  demoActive = true;
  setMode('demo');
  setSensorStatus('disconnected', 'DEMO · NO SENSOR');
  ui.sensorHeadline.textContent = 'Demo simulation active';
  ui.sensorSubline.textContent = 'Pointer position is used only in this sandbox.';
  ui.sensorNote.textContent = 'DEMO MODE is synthetic. No magnetometer data is being read.';
  clearTelemetry();
  ui.demoToggleButton.textContent = 'Stop demo mode';
  ui.demoToggleButton.setAttribute('aria-pressed', 'true');
  ui.demoStage.dataset.active = 'true';
  ui.demoHint.textContent = 'MOVE POINTER / TOUCH — SIMULATED FORCE ONLY';
  showToast('Demo mode on — this is not real sensor detection.');
}

function stopDemo() {
  demoActive = false;
  motion.reset();
  ui.demoToggleButton.textContent = 'Start demo mode';
  ui.demoToggleButton.setAttribute('aria-pressed', 'false');
  ui.demoStage.dataset.active = 'false';
  ui.demoHint.textContent = 'MOVE POINTER / TOUCH TO CREATE A MAGNETIC FIELD';
  setMode(hasAnySupportedInput() ? 'ready' : 'unsupported');
  if (realSource) realSource = null;
  ui.sensorHeadline.textContent = 'Demo stopped';
  ui.sensorSubline.textContent = 'Activate a real sensor or start the demo again.';
}

function toggleDemo() {
  if (demoActive) stopDemo(); else startDemo();
}

function handleDemoPointer(event) {
  if (!demoActive) return;
  const bounds = ui.demoStage.getBoundingClientRect();
  const x = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  const y = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
  const vx = (x - 0.5) * 2;
  const vy = (y - 0.5) * 2;
  const distance = Math.hypot(vx, vy);
  const directionScale = distance > 1 ? 1 / distance : 1;
  const direction = { x: vx * directionScale, y: vy * directionScale };
  const strength = clamp(distance / 0.7, 0, 1);
  motion.setTarget(inverted ? -direction.x : direction.x, inverted ? -direction.y : direction.y, strength);
  ui.demoTarget.style.left = `${x * 100}%`;
  ui.demoTarget.style.top = `${y * 100}%`;
}

function resetDemoTarget() {
  if (!demoActive) return;
  motion.reset();
  ui.demoTarget.style.left = '50%';
  ui.demoTarget.style.top = '50%';
}

function resetSettings() {
  ui.forceRange.value = '1';
  ui.sensitivityRange.value = '1';
  ui.smoothRange.value = '0.82';
  inverted = false;
  ui.invertButton.setAttribute('aria-pressed', 'false');
  ui.invertButton.classList.remove('is-selected');
  motion.setSettings({ force: 1, smoothness: 0.82 });
  motion.reset();
  updateRangeLabels();
  baseline = null;
  calibration = null;
  warmupSamples = [];
  capturedDirections = {};
  clearCalibration();
  updateCalibrationUI();
  showToast('Settings and saved calibration reset.');
}

function updateRangeLabels() {
  const force = Number(ui.forceRange.value);
  const sensitivity = Number(ui.sensitivityRange.value);
  const smoothness = Number(ui.smoothRange.value);
  ui.forceValue.value = `${force.toFixed(2)}×`;
  ui.sensitivityValue.value = `${sensitivity.toFixed(2)}×`;
  ui.smoothValue.value = smoothness.toFixed(2);
  motion.setSettings({ force, smoothness });
}

function openCalibration() {
  if (!realSource || !latestReading) {
    showToast('Connect a real magnetometer or external sensor before calibrating.', 'error');
    return;
  }
  capturedDirections = {};
  activeCapture = null;
  $('#wizardBaseline').classList.remove('is-done');
  ['left', 'right', 'up', 'down'].forEach((key) => {
    $(`#wizard${key[0].toUpperCase()}${key.slice(1)}`).classList.add('is-disabled');
    $(`[data-capture="${key}"]`).disabled = true;
    $(`[data-capture="${key}"]`).textContent = `Capture ${key}`;
  });
  ui.captureBaselineButton.disabled = false;
  ui.captureBaselineButton.textContent = 'Capture baseline';
  ui.wizardStatus.textContent = 'Ready. Remove the magnet, then capture the ambient field.';
  ui.calibrationDialog.showModal();
}

function collectAveragedSamples(duration = 1600) {
  return new Promise((resolve, reject) => {
    if (!realSource || !latestReading) {
      reject(new Error('No live physical sensor is connected.'));
      return;
    }
    const capture = { samples: [] };
    activeCapture = capture;
    const timeout = setTimeout(() => {
      if (activeCapture === capture) activeCapture = null;
      if (capture.samples.length < 8) {
        reject(new Error('Not enough sensor readings were collected. Keep the sensor running and try again.'));
      } else {
        try { resolve(averageVector(capture.samples)); } catch (error) { reject(error); }
      }
    }, duration);
    capture.cancel = () => { clearTimeout(timeout); reject(new Error('Calibration capture cancelled.')); };
  });
}

async function captureBaseline() {
  ui.captureBaselineButton.disabled = true;
  ui.wizardStatus.textContent = 'Capturing ambient field for 1.6 seconds…';
  try {
    const captured = await collectAveragedSamples();
    baseline = captured;
    calibration = null;
    clearCalibration();
    capturedDirections = {};
    $('#wizardBaseline').classList.add('is-done');
    ['left', 'right', 'up', 'down'].forEach((key) => {
      $(`#wizard${key[0].toUpperCase()}${key.slice(1)}`).classList.remove('is-disabled');
      $(`[data-capture="${key}"]`).disabled = false;
    });
    ui.captureBaselineButton.textContent = 'Baseline saved';
    ui.wizardStatus.textContent = 'Baseline saved. Capture the magnet at each of the four screen edges.';
    ui.sensorNote.textContent = 'Manual baseline captured. Four-point mapping is in progress.';
    updateCalibrationUI();
  } catch (error) {
    ui.wizardStatus.textContent = error.message;
    ui.captureBaselineButton.disabled = false;
  }
}

async function captureDirection(direction) {
  if (!baseline) {
    ui.wizardStatus.textContent = 'Capture the ambient baseline first.';
    return;
  }
  const button = $(`[data-capture="${direction}"]`);
  button.disabled = true;
  button.textContent = 'Sampling…';
  ui.wizardStatus.textContent = `Sampling ${direction.toUpperCase()} for 1.6 seconds… keep the magnet steady.`;
  try {
    const field = await collectAveragedSamples();
    const delta = subtractVectors(field, baseline);
    if (vectorMagnitude(delta) < 1.2) throw new Error(`The ${direction} sample looks too close to baseline. Move the magnet nearer and retry.`);
    capturedDirections[direction] = delta;
    button.textContent = 'Captured ✓';
    button.disabled = true;
    updateCalibrationUI();
    const completed = Object.keys(capturedDirections).length;
    ui.wizardStatus.textContent = `${completed}/4 directional samples captured.`;
    if (completed === 4) {
      const matrix = fitDirectionMapping(capturedDirections);
      calibration = {
        baseline,
        matrix,
        samples: capturedDirections,
        createdAt: new Date().toISOString(),
        method: 'four-point-ridge-regression',
      };
      const persisted = saveCalibration(calibration);
      updateCalibrationUI();
      ui.wizardStatus.textContent = persisted
        ? 'Calibration complete and saved on this device. You can close this window.'
        : 'Calibration complete, but browser storage is unavailable. It will last until this page closes.';
      showToast('Four-direction calibration completed.');
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = `Retry ${direction}`;
    ui.wizardStatus.textContent = error.message;
  }
}

function cancelCalibration() {
  if (activeCapture?.cancel) activeCapture.cancel();
  activeCapture = null;
  if (ui.calibrationDialog.open) ui.calibrationDialog.close();
}

function updateCapabilityUI() {
  ui.serialButton.disabled = !capabilities.usbSerial || !capabilities.secure;
  ui.bleButton.disabled = !capabilities.bluetoothLE || !capabilities.secure;
  if (!capabilities.secure) {
    setMode('unsupported');
    ui.sensorSubline.textContent = 'Secure context required. Use HTTPS or localhost to access hardware APIs.';
    ui.sensorNote.textContent = 'Magnetometer, USB Serial and Bluetooth access require a secure context.';
  } else if (capabilities.builtInMagnetometer) {
    setMode('ready');
    ui.sensorSubline.textContent = 'Magnetometer API detected. Hardware availability is confirmed only after the first real reading.';
    ui.sensorNote.textContent = capabilities.uncalibratedMagnetometer
      ? 'UncalibratedMagnetometer is preferred to retain changes from nearby magnetic objects.'
      : 'Magnetometer API detected. No reading is shown until the hardware sends real data.';
  } else if (capabilities.usbSerial || capabilities.bluetoothLE) {
    setMode('ready');
    ui.sensorSubline.textContent = 'No built-in sensor API detected. An external USB/BLE sensor may be connected.';
    ui.sensorNote.textContent = 'External devices require a compatible serial JSON stream or a BLE GATT service/characteristic.';
  } else {
    setMode('unsupported');
    ui.sensorSubline.textContent = 'No supported built-in or external sensor interface was detected in this browser.';
    ui.sensorNote.textContent = 'Try a compatible mobile browser, or use a microcontroller with USB Serial / BLE GATT support.';
  }
  if (calibration) updateCalibrationUI();
}

ui.startSensorButton.addEventListener('click', startBuiltInSensor);
ui.stopSensorButton.addEventListener('click', stopSensor);
ui.serialButton.addEventListener('click', startSerial);
ui.bleButton.addEventListener('click', startBluetooth);
ui.demoToggleButton.addEventListener('click', toggleDemo);
ui.heroDemoButton.addEventListener('click', () => {
  startDemo();
  ui.demoStage.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
ui.demoStage.addEventListener('pointermove', handleDemoPointer);
ui.demoStage.addEventListener('pointerdown', (event) => { if (demoActive) handleDemoPointer(event); });
ui.demoStage.addEventListener('pointerleave', resetDemoTarget);
ui.demoStage.addEventListener('pointercancel', resetDemoTarget);
ui.forceRange.addEventListener('input', updateRangeLabels);
ui.sensitivityRange.addEventListener('input', updateRangeLabels);
ui.smoothRange.addEventListener('input', updateRangeLabels);
ui.invertButton.addEventListener('click', () => {
  inverted = !inverted;
  ui.invertButton.setAttribute('aria-pressed', String(inverted));
  ui.invertButton.classList.toggle('is-selected', inverted);
  showToast(inverted ? 'Direction inverted.' : 'Direction restored.');
});
ui.resetButton.addEventListener('click', resetSettings);
ui.calibrateButton.addEventListener('click', openCalibration);
ui.captureBaselineButton.addEventListener('click', captureBaseline);
ui.calibrationDialog.querySelectorAll('[data-capture]').forEach((button) => {
  button.addEventListener('click', () => captureDirection(button.dataset.capture));
});
ui.cancelCalibrationButton.addEventListener('click', cancelCalibration);
ui.themeInfoButton.addEventListener('click', () => {
  const lines = [
    `Secure context: ${capabilities.secure ? 'yes' : 'no'}`,
    `Built-in Magnetometer API: ${capabilities.builtInMagnetometer ? 'detected' : 'not detected'}`,
    `USB Serial: ${capabilities.usbSerial ? 'available' : 'not available'}`,
    `Bluetooth LE: ${capabilities.bluetoothLE ? 'available' : 'not available'}`,
    'Hardware is confirmed only after an actual reading arrives.',
  ];
  showToast(lines.join(' · '));
});

window.addEventListener('beforeunload', () => {
  hub.stop().catch(() => {});
  motion.destroy();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && realSource) {
    hub.stop().catch(() => {});
    realSource = null;
    motion.reset();
    ui.sensorHeadline.textContent = 'Sensor paused';
    ui.sensorSubline.textContent = 'The connection was stopped while the page was hidden to save power. Reconnect when ready.';
    setMode(hasAnySupportedInput() ? 'ready' : 'unsupported');
  }
});

updateCapabilityUI();
updateRangeLabels();
updateCalibrationUI();
