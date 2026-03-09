/*
  Classroom Noise Meter
  ---------------------
  - Uses Web Audio API to estimate loudness from microphone input.
  - Computes RMS (root mean square) from the waveform each animation frame.
  - Applies an exponential moving average to smooth jitter.
  - Updates a detention tally when loudness exceeds threshold.
  - Stores only teacher settings in localStorage (no audio data saved).
*/

const SETTINGS_KEY = "classroom-noise-meter-settings-v1";
const DEFAULT_SETTINGS = {
  threshold: 60,
  sensitivity: 100,
  reinforcementEnabled: false,
  quietStreakSeconds: 30,
  creepArmSeconds: 4,
  productivityFillSeconds: 150,
  productivityDrainSeconds: 70,
  selectedPreset: "balanced",
  presenterMode: false
};

const PRESETS = {
  strict: {
    threshold: 52,
    sensitivity: 120,
    creepArmSeconds: 2.5,
    productivityFillSeconds: 220,
    productivityDrainSeconds: 45
  },
  balanced: {
    threshold: 60,
    sensitivity: 100,
    creepArmSeconds: 4,
    productivityFillSeconds: 150,
    productivityDrainSeconds: 70
  },
  forgiving: {
    threshold: 70,
    sensitivity: 85,
    creepArmSeconds: 6.5,
    productivityFillSeconds: 110,
    productivityDrainSeconds: 120
  }
};

// Reinforcement cadence: once quiet streak is achieved,
// subtract 1 second from tally every 5 seconds of continued quiet.
const DEDUCT_EVERY_SECONDS = 5;
const CREEP_NEAR_RATE_RATIO = 0.32;
const CREEP_DECAY_SLOW_RATIO = 0.6;
const CREEP_DECAY_FAST_RATIO = 1.4;
const PRODUCTIVITY_NEAR_FILL_RATIO = 0.58;

const ui = {
  micToggle: document.getElementById("micToggle"),
  calibrateButton: document.getElementById("calibrateButton"),
  calibrateStatus: document.getElementById("calibrateStatus"),
  presenterToggle: document.getElementById("presenterToggle"),
  presenterHint: document.getElementById("presenterHint"),
  exitPresenter: document.getElementById("exitPresenter"),
  thresholdSlider: document.getElementById("thresholdSlider"),
  thresholdValue: document.getElementById("thresholdValue"),
  sensitivitySlider: document.getElementById("sensitivitySlider"),
  sensitivityValue: document.getElementById("sensitivityValue"),
  creepArmSlider: document.getElementById("creepArmSlider"),
  creepArmValue: document.getElementById("creepArmValue"),
  productivityFillSlider: document.getElementById("productivityFillSlider"),
  productivityFillValue: document.getElementById("productivityFillValue"),
  productivityDrainSlider: document.getElementById("productivityDrainSlider"),
  productivityDrainValue: document.getElementById("productivityDrainValue"),
  presetStrict: document.getElementById("presetStrict"),
  presetBalanced: document.getElementById("presetBalanced"),
  presetForgiving: document.getElementById("presetForgiving"),
  presetValue: document.getElementById("presetValue"),
  reinforcementToggle: document.getElementById("reinforcementToggle"),
  quietStreakInput: document.getElementById("quietStreakInput"),
  meterBar: document.getElementById("meterBar"),
  meterFill: document.getElementById("meterFill"),
  meterValue: document.getElementById("meterValue"),
  creepBar: document.getElementById("creepBar"),
  creepFill: document.getElementById("creepFill"),
  creepStatus: document.getElementById("creepStatus"),
  tallyValue: document.getElementById("tallyValue"),
  productivityBar: document.getElementById("productivityBar"),
  productivityFill: document.getElementById("productivityFill"),
  productivityValue: document.getElementById("productivityValue"),
  resetTally: document.getElementById("resetTally"),
  exportCsv: document.getElementById("exportCsv"),
  statusMessage: document.getElementById("statusMessage")
};

const state = {
  audioContext: null,
  analyserNode: null,
  sourceNode: null,
  mediaStream: null,
  timeDomainData: null,
  rafId: null,
  isRunning: false,
  lastFrameTimeMs: 0,

  smoothedLoudness: 0,
  tallySeconds: 0,
  aboveAccumulator: 0,
  creepPercent: 0,
  productivityPercent: 0,
  quietSeconds: 0,
  quietDeductAccumulator: 0,

  calibrating: false,
  calibrationSamples: [],
  calibrationEndTimeMs: 0
};

let currentPreset = DEFAULT_SETTINGS.selectedPreset;

function normalizePresetName(value) {
  if (value === "strict" || value === "balanced" || value === "forgiving" || value === "custom") {
    return value;
  }

  return DEFAULT_SETTINGS.selectedPreset;
}

function formatPresetLabel(value) {
  switch (value) {
    case "strict":
      return "Strict";
    case "balanced":
      return "Balanced";
    case "forgiving":
      return "Forgiving";
    default:
      return "Custom";
  }
}

function updatePresetUI() {
  ui.presetStrict.classList.toggle("active", currentPreset === "strict");
  ui.presetBalanced.classList.toggle("active", currentPreset === "balanced");
  ui.presetForgiving.classList.toggle("active", currentPreset === "forgiving");
  ui.presetValue.textContent = formatPresetLabel(currentPreset);
}

function markPresetCustom() {
  if (currentPreset === "custom") {
    return;
  }

  currentPreset = "custom";
  updatePresetUI();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatSecondsAsMMSS(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setStatus(text, type = "info") {
  ui.statusMessage.textContent = text;
  ui.statusMessage.className = `status ${type}`;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }

    const parsed = JSON.parse(raw);
    return {
      threshold: clamp(Number(parsed.threshold) || DEFAULT_SETTINGS.threshold, 0, 100),
      sensitivity: clamp(Number(parsed.sensitivity) || DEFAULT_SETTINGS.sensitivity, 50, 300),
      reinforcementEnabled: Boolean(parsed.reinforcementEnabled),
      quietStreakSeconds: clamp(Number(parsed.quietStreakSeconds) || DEFAULT_SETTINGS.quietStreakSeconds, 10, 300),
      creepArmSeconds: clamp(Number(parsed.creepArmSeconds) || DEFAULT_SETTINGS.creepArmSeconds, 2, 12),
      productivityFillSeconds: clamp(Number(parsed.productivityFillSeconds) || DEFAULT_SETTINGS.productivityFillSeconds, 60, 600),
      productivityDrainSeconds: clamp(Number(parsed.productivityDrainSeconds) || DEFAULT_SETTINGS.productivityDrainSeconds, 30, 300),
      selectedPreset: normalizePresetName(parsed.selectedPreset),
      presenterMode: Boolean(parsed.presenterMode)
    };
  } catch {
    // If localStorage is blocked or JSON is invalid, continue safely with defaults.
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  const settings = {
    threshold: Number(ui.thresholdSlider.value),
    sensitivity: Number(ui.sensitivitySlider.value),
    reinforcementEnabled: ui.reinforcementToggle.checked,
    quietStreakSeconds: clamp(Number(ui.quietStreakInput.value) || 30, 10, 300),
    creepArmSeconds: clamp(Number(ui.creepArmSlider.value) || DEFAULT_SETTINGS.creepArmSeconds, 2, 12),
    productivityFillSeconds: clamp(Number(ui.productivityFillSlider.value) || DEFAULT_SETTINGS.productivityFillSeconds, 60, 600),
    productivityDrainSeconds: clamp(Number(ui.productivityDrainSlider.value) || DEFAULT_SETTINGS.productivityDrainSeconds, 30, 300),
    selectedPreset: currentPreset,
    presenterMode: ui.presenterToggle.checked
  };

  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can fail in private mode or restricted environments.
    // This is non-fatal, so we keep the app running.
  }
}

function applySettingsToUI(settings) {
  currentPreset = normalizePresetName(settings.selectedPreset);
  ui.thresholdSlider.value = String(settings.threshold);
  ui.sensitivitySlider.value = String(settings.sensitivity);
  ui.creepArmSlider.value = String(settings.creepArmSeconds);
  ui.productivityFillSlider.value = String(settings.productivityFillSeconds);
  ui.productivityDrainSlider.value = String(settings.productivityDrainSeconds);
  ui.reinforcementToggle.checked = settings.reinforcementEnabled;
  ui.quietStreakInput.value = String(settings.quietStreakSeconds);
  ui.presenterToggle.checked = settings.presenterMode;
  ui.quietStreakInput.disabled = !settings.reinforcementEnabled;

  ui.thresholdValue.textContent = String(settings.threshold);
  ui.sensitivityValue.textContent = `${settings.sensitivity}%`;
  renderTeacherTuningValues();
  updatePresetUI();
}

function applyPreset(presetName) {
  const safeName = normalizePresetName(presetName);
  const preset = PRESETS[safeName];
  if (!preset) {
    return;
  }

  currentPreset = safeName;
  ui.thresholdSlider.value = String(preset.threshold);
  ui.sensitivitySlider.value = String(preset.sensitivity);
  ui.creepArmSlider.value = String(preset.creepArmSeconds);
  ui.productivityFillSlider.value = String(preset.productivityFillSeconds);
  ui.productivityDrainSlider.value = String(preset.productivityDrainSeconds);

  ui.thresholdValue.textContent = String(preset.threshold);
  ui.sensitivityValue.textContent = `${preset.sensitivity}%`;
  renderTeacherTuningValues();
  updatePresetUI();
  saveSettings();
  setStatus(`${formatPresetLabel(safeName)} preset applied.`, "info");
}

function renderTeacherTuningValues() {
  const creepArmSeconds = clamp(Number(ui.creepArmSlider.value) || DEFAULT_SETTINGS.creepArmSeconds, 2, 12);
  const productivityFillSeconds = clamp(Number(ui.productivityFillSlider.value) || DEFAULT_SETTINGS.productivityFillSeconds, 60, 600);
  const productivityDrainSeconds = clamp(Number(ui.productivityDrainSlider.value) || DEFAULT_SETTINGS.productivityDrainSeconds, 30, 300);

  ui.creepArmValue.textContent = `${creepArmSeconds.toFixed(1)}s`;
  ui.productivityFillValue.textContent = `${Math.round(productivityFillSeconds)}s`;
  ui.productivityDrainValue.textContent = `${Math.round(productivityDrainSeconds)}s`;
}

function setPresenterMode(enabled, save = true) {
  document.body.classList.toggle("presenter-mode", enabled);
  ui.presenterToggle.checked = enabled;
  ui.presenterHint.hidden = !enabled;
  ui.exitPresenter.hidden = !enabled;

  if (save) {
    saveSettings();
  }
}

function renderTally() {
  ui.tallyValue.textContent = formatSecondsAsMMSS(state.tallySeconds);
}

function renderMeter(loudnessPercent) {
  const rounded = Math.round(loudnessPercent);
  ui.meterFill.style.width = `${rounded}%`;
  ui.meterValue.textContent = `${rounded}%`;
  ui.meterBar.setAttribute("aria-valuenow", String(rounded));

  const threshold = Number(ui.thresholdSlider.value);
  if (loudnessPercent > threshold) {
    ui.meterFill.className = "meter-fill loud";
    return;
  }

  // "Near threshold" zone = 80% of threshold and above.
  if (loudnessPercent >= threshold * 0.8) {
    ui.meterFill.className = "meter-fill near";
  } else {
    ui.meterFill.className = "meter-fill quiet";
  }
}

function renderSlowCreep(creepPercent) {
  const rounded = Math.round(clamp(creepPercent, 0, 100));
  ui.creepFill.style.width = `${rounded}%`;
  ui.creepBar.setAttribute("aria-valuenow", String(rounded));

  if (rounded >= 100) {
    ui.creepFill.className = "sub-meter-fill loud";
    ui.creepStatus.textContent = "Detention imminent";
    return;
  }

  if (rounded >= 60) {
    ui.creepFill.className = "sub-meter-fill near";
    ui.creepStatus.textContent = "Warning";
    return;
  }

  if (rounded >= 20) {
    ui.creepFill.className = "sub-meter-fill quiet";
    ui.creepStatus.textContent = "Caution";
    return;
  }

  ui.creepFill.className = "sub-meter-fill quiet";
  ui.creepStatus.textContent = "Good";
}

function renderProductivity(productivityPercent) {
  const rounded = Math.round(clamp(productivityPercent, 0, 100));
  ui.productivityFill.style.width = `${rounded}%`;
  ui.productivityValue.textContent = `${rounded}%`;
  ui.productivityBar.setAttribute("aria-valuenow", String(rounded));

  if (rounded >= 70) {
    ui.productivityFill.className = "sub-meter-fill quiet";
  } else if (rounded >= 35) {
    ui.productivityFill.className = "sub-meter-fill near";
  } else {
    ui.productivityFill.className = "sub-meter-fill loud";
  }
}

function updateSlowCreepDetector(currentLoudness, deltaSeconds) {
  const threshold = Number(ui.thresholdSlider.value);
  const creepArmSeconds = clamp(Number(ui.creepArmSlider.value) || DEFAULT_SETTINGS.creepArmSeconds, 2, 12);
  const nearThreshold = threshold * 0.8;
  const settleThreshold = threshold * 0.6;
  const fillPerSecond = 100 / creepArmSeconds;
  const nearFillPerSecond = fillPerSecond * CREEP_NEAR_RATE_RATIO;
  const decaySlowPerSecond = fillPerSecond * CREEP_DECAY_SLOW_RATIO;
  const decayFastPerSecond = fillPerSecond * CREEP_DECAY_FAST_RATIO;

  if (currentLoudness > threshold) {
    state.creepPercent += deltaSeconds * fillPerSecond;
  } else if (currentLoudness >= nearThreshold) {
    state.creepPercent += deltaSeconds * nearFillPerSecond;
  } else if (currentLoudness >= settleThreshold) {
    state.creepPercent -= deltaSeconds * decaySlowPerSecond;
  } else {
    state.creepPercent -= deltaSeconds * decayFastPerSecond;
  }

  state.creepPercent = clamp(state.creepPercent, 0, 100);
  renderSlowCreep(state.creepPercent);
  return state.creepPercent >= 100;
}

function updateProductivityProgress(currentLoudness, deltaSeconds) {
  const threshold = Number(ui.thresholdSlider.value);
  const productivityFillSeconds = clamp(Number(ui.productivityFillSlider.value) || DEFAULT_SETTINGS.productivityFillSeconds, 60, 600);
  const productivityDrainSeconds = clamp(Number(ui.productivityDrainSlider.value) || DEFAULT_SETTINGS.productivityDrainSeconds, 30, 300);
  const nearThreshold = threshold * 0.8;
  const fillPerSecond = 100 / productivityFillSeconds;
  const nearFillPerSecond = fillPerSecond * PRODUCTIVITY_NEAR_FILL_RATIO;
  const drainPerSecond = 100 / productivityDrainSeconds;

  if (currentLoudness <= nearThreshold) {
    state.productivityPercent += deltaSeconds * fillPerSecond;
  } else if (currentLoudness <= threshold) {
    state.productivityPercent += deltaSeconds * nearFillPerSecond;
  } else {
    state.productivityPercent -= deltaSeconds * drainPerSecond;
  }

  state.productivityPercent = clamp(state.productivityPercent, 0, 100);
  renderProductivity(state.productivityPercent);
}

function resetRunningAccumulators() {
  state.aboveAccumulator = 0;
  state.creepPercent = 0;
  state.quietSeconds = 0;
  state.quietDeductAccumulator = 0;
  renderSlowCreep(0);
}

function handleTallyLogic(currentLoudness, deltaSeconds) {
  const threshold = Number(ui.thresholdSlider.value);
  const reinforcementEnabled = ui.reinforcementToggle.checked;
  const quietStreak = clamp(Number(ui.quietStreakInput.value) || 30, 10, 300);
  const creepArmed = updateSlowCreepDetector(currentLoudness, deltaSeconds);
  updateProductivityProgress(currentLoudness, deltaSeconds);

  if (currentLoudness > threshold) {
    if (!creepArmed) {
      state.aboveAccumulator = 0;
      state.quietSeconds = 0;
      state.quietDeductAccumulator = 0;
      return;
    }

    // Add tally at real time: +1 second for each full second above threshold.
    state.aboveAccumulator += deltaSeconds;

    while (state.aboveAccumulator >= 1) {
      state.tallySeconds += 1;
      state.aboveAccumulator -= 1;
      renderTally();
    }

    // Noise above threshold breaks quiet streak.
    state.quietSeconds = 0;
    state.quietDeductAccumulator = 0;
    return;
  }

  // Not above threshold: stop adding and track quiet duration.
  state.quietSeconds += deltaSeconds;

  if (!reinforcementEnabled || state.tallySeconds <= 0) {
    state.quietDeductAccumulator = 0;
    return;
  }

  if (state.quietSeconds < quietStreak) {
    return;
  }

  // After quiet streak is reached, deduct gradually as positive reinforcement.
  state.quietDeductAccumulator += deltaSeconds;

  while (state.quietDeductAccumulator >= DEDUCT_EVERY_SECONDS && state.tallySeconds > 0) {
    state.tallySeconds = Math.max(0, state.tallySeconds - 1);
    state.quietDeductAccumulator -= DEDUCT_EVERY_SECONDS;
    renderTally();
  }
}

function processAudioFrame(nowMs) {
  if (!state.isRunning || !state.analyserNode || !state.timeDomainData) {
    return;
  }

  const deltaSeconds = clamp((nowMs - state.lastFrameTimeMs) / 1000, 0, 0.5);
  state.lastFrameTimeMs = nowMs;

  // Pull waveform samples in byte form [0..255].
  // 128 is the "center line" (silence midpoint).
  state.analyserNode.getByteTimeDomainData(state.timeDomainData);

  // RMS math (beginner explanation):
  // 1) Center each sample around 0: (sample - 128) / 128  -> roughly [-1, 1]
  // 2) Square values so negatives do not cancel positives.
  // 3) Average the squared values.
  // 4) Take square root to bring back to original scale.
  // Result: one stable "energy" number for current audio frame.
  let sumSquares = 0;
  for (let i = 0; i < state.timeDomainData.length; i += 1) {
    const centered = (state.timeDomainData[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / state.timeDomainData.length);

  // Convert RMS to UI scale.
  // Sensitivity is a simple multiplier so teachers can adapt to room acoustics.
  const sensitivity = Number(ui.sensitivitySlider.value) / 100;
  const rawLoudness = rms * sensitivity * 220;

  // Exponential moving average (EMA) smoothing:
  // smoothed = old + alpha * (new - old)
  // Smaller alpha = smoother but slower; larger alpha = more responsive.
  const alpha = 0.18;
  const clampedRaw = clamp(rawLoudness, 0, 100);
  state.smoothedLoudness = state.smoothedLoudness + alpha * (clampedRaw - state.smoothedLoudness);

  const loudnessForUI = clamp(state.smoothedLoudness, 0, 100);
  renderMeter(loudnessForUI);
  handleTallyLogic(loudnessForUI, deltaSeconds);

  if (state.calibrating) {
    state.calibrationSamples.push(loudnessForUI);
    if (nowMs >= state.calibrationEndTimeMs) {
      finishCalibration();
    }
  }

  state.rafId = requestAnimationFrame(processAudioFrame);
}

async function startMicrophone() {
  if (state.isRunning) {
    return;
  }

  // Most browsers require secure context for microphone.
  const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalhost) {
    setStatus("Microphone requires HTTPS (or localhost). Please run this app via a secure URL.", "error");
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("This browser does not support microphone access via getUserMedia.", "error");
    return;
  }

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("AudioContext is not supported in this browser.");
    }

    state.audioContext = new AudioCtx();
    state.analyserNode = state.audioContext.createAnalyser();
    state.analyserNode.fftSize = 2048;
    state.analyserNode.smoothingTimeConstant = 0;

    state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.sourceNode.connect(state.analyserNode);

    state.timeDomainData = new Uint8Array(state.analyserNode.fftSize);

    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    state.audioContext.onstatechange = () => {
      if (!state.audioContext || !state.isRunning) {
        return;
      }
      if (state.audioContext.state === "suspended") {
        setStatus("Audio context paused. Click Start Microphone again if needed.", "warn");
      }
    };

    state.isRunning = true;
    state.lastFrameTimeMs = performance.now();
    state.smoothedLoudness = 0;
    resetRunningAccumulators();

    ui.micToggle.textContent = "Stop Microphone";
    ui.micToggle.setAttribute("aria-pressed", "true");
    setStatus("Microphone started. Live analysis is running locally.", "info");

    state.rafId = requestAnimationFrame(processAudioFrame);
  } catch (error) {
    await stopMicrophone();

    if (error && error.name === "NotAllowedError") {
      setStatus("Please allow microphone access to use the live noise meter.", "error");
      return;
    }

    if (error && error.name === "NotFoundError") {
      setStatus("No microphone was found. Connect a microphone and try again.", "error");
      return;
    }

    const message = error && error.message ? error.message : "Unknown microphone error.";
    setStatus(`Could not start microphone: ${message}`, "error");
  }
}

async function stopMicrophone() {
  state.isRunning = false;

  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }

  if (state.analyserNode) {
    state.analyserNode.disconnect();
    state.analyserNode = null;
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }

  if (state.audioContext) {
    try {
      await state.audioContext.close();
    } catch {
      // Ignore close errors.
    }
    state.audioContext = null;
  }

  state.timeDomainData = null;

  if (state.calibrating) {
    state.calibrating = false;
    state.calibrationSamples = [];
    ui.calibrateButton.disabled = false;
    ui.calibrateStatus.textContent = "Calibration canceled.";
  }

  ui.micToggle.textContent = "Start Microphone";
  ui.micToggle.setAttribute("aria-pressed", "false");
  renderMeter(0);
  state.creepPercent = 0;
  renderSlowCreep(0);
}

async function toggleMicrophone() {
  if (state.isRunning) {
    await stopMicrophone();
    setStatus("Microphone stopped and released.", "info");
  } else {
    await startMicrophone();
  }
}

function startCalibration() {
  if (!state.isRunning) {
    setStatus("Start the microphone first, then run calibration.", "warn");
    return;
  }

  if (state.calibrating) {
    return;
  }

  state.calibrating = true;
  state.calibrationSamples = [];
  state.calibrationEndTimeMs = performance.now() + 2500;

  ui.calibrateButton.disabled = true;
  ui.calibrateStatus.textContent = "Calibrating... keep room at normal background noise for 2.5 seconds.";
}

function finishCalibration() {
  state.calibrating = false;
  ui.calibrateButton.disabled = false;

  if (state.calibrationSamples.length === 0) {
    ui.calibrateStatus.textContent = "Calibration failed. Try again.";
    return;
  }

  const sum = state.calibrationSamples.reduce((acc, value) => acc + value, 0);
  const average = sum / state.calibrationSamples.length;

  // Suggest threshold above baseline so normal room noise stays mostly below line.
  const suggested = Math.round(clamp(average + 12, 10, 95));
  ui.thresholdSlider.value = String(suggested);
  ui.thresholdValue.textContent = String(suggested);
  saveSettings();

  ui.calibrateStatus.textContent = `Calibration complete. Suggested threshold set to ${suggested}.`;
  setStatus("Calibration complete. Review threshold and adjust if needed.", "info");
}

function resetTally() {
  state.tallySeconds = 0;
  state.productivityPercent = 0;
  resetRunningAccumulators();
  renderTally();
  renderProductivity(0);
}

function exportSessionCsv() {
  const nowIso = new Date().toISOString();
  const csvLines = [
    "timestamp,session_total_seconds,session_total_mmss",
    `${nowIso},${state.tallySeconds},${formatSecondsAsMMSS(state.tallySeconds)}`
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `noise-session-summary-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function setupEventListeners() {
  ui.micToggle.addEventListener("click", toggleMicrophone);
  ui.calibrateButton.addEventListener("click", startCalibration);

  ui.thresholdSlider.addEventListener("input", () => {
    ui.thresholdValue.textContent = ui.thresholdSlider.value;
    markPresetCustom();
    saveSettings();
  });

  ui.sensitivitySlider.addEventListener("input", () => {
    ui.sensitivityValue.textContent = `${ui.sensitivitySlider.value}%`;
    markPresetCustom();
    saveSettings();
  });

  ui.creepArmSlider.addEventListener("input", () => {
    markPresetCustom();
    renderTeacherTuningValues();
    saveSettings();
  });

  ui.productivityFillSlider.addEventListener("input", () => {
    markPresetCustom();
    renderTeacherTuningValues();
    saveSettings();
  });

  ui.productivityDrainSlider.addEventListener("input", () => {
    markPresetCustom();
    renderTeacherTuningValues();
    saveSettings();
  });

  ui.presetStrict.addEventListener("click", () => {
    applyPreset("strict");
  });

  ui.presetBalanced.addEventListener("click", () => {
    applyPreset("balanced");
  });

  ui.presetForgiving.addEventListener("click", () => {
    applyPreset("forgiving");
  });

  ui.reinforcementToggle.addEventListener("change", () => {
    ui.quietStreakInput.disabled = !ui.reinforcementToggle.checked;
    state.quietSeconds = 0;
    state.quietDeductAccumulator = 0;
    saveSettings();
  });

  ui.quietStreakInput.addEventListener("change", () => {
    const safe = clamp(Number(ui.quietStreakInput.value) || 30, 10, 300);
    ui.quietStreakInput.value = String(safe);
    saveSettings();
  });

  ui.presenterToggle.addEventListener("change", () => {
    setPresenterMode(ui.presenterToggle.checked);
  });

  ui.exitPresenter.addEventListener("click", () => {
    setPresenterMode(false);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "p" || event.key === "P") {
      setPresenterMode(!document.body.classList.contains("presenter-mode"));
      return;
    }

    if (event.key === "Escape" && document.body.classList.contains("presenter-mode")) {
      setPresenterMode(false);
    }
  });

  ui.resetTally.addEventListener("click", resetTally);
  ui.exportCsv.addEventListener("click", exportSessionCsv);

  window.addEventListener("beforeunload", () => {
    // Ensure tracks are stopped when tab closes.
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
    }
  });
}

function init() {
  const settings = loadSettings();
  applySettingsToUI(settings);
  setPresenterMode(settings.presenterMode, false);
  renderMeter(0);
  renderSlowCreep(0);
  renderProductivity(0);
  renderTally();
  setupEventListeners();
}

init();
