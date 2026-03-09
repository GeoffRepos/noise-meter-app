# Classroom Noise Meter (MVP)

A minimal, production-ready browser app for measuring ambient classroom noise from the laptop microphone.

- Pure HTML + CSS + Vanilla JS
- Web Audio API (`getUserMedia`, `AudioContext`, `AnalyserNode`)
- Local-only processing (no audio recording, no uploads)

## Privacy

**Analysis happens locally. No audio is recorded or sent anywhere.**

The app only stores teacher preferences in `localStorage`:

- Threshold
- Sensitivity
- Slow creep grace time
- Productivity fill/drain pace
- Positive reinforcement toggle
- Quiet streak seconds

No raw audio buffers or time-series history are stored.

## Features

- Start/Stop microphone analysis
- Live 0–100 noise meter (green / amber / red)
- Noise detector (status ranges from Good to Detention imminent; requires sustained loudness before detention time starts)
- Threshold + sensitivity controls
- Teacher-facing tuning controls for slow creep and productivity pace
- One-click presets: Strict, Balanced, Forgiving (manual edits switch to Custom)
- 2.5-second calibration helper with suggested threshold
- Detention tally timer (increments while above threshold after slow creep detector arms)
- Background productivity bar (fills during quiet time, drains during loud periods)
- Optional positive reinforcement deduction while quiet
- Reset tally
- CSV export of session summary only (timestamp + total)
- Presenter mode (meter + tally only), toggle via UI or P (Esc and Exit button both close it)

## How to run (VS Code Live Server)

1. Open this folder in VS Code.
2. Install the **Live Server** extension if needed.
3. Right-click `index.html` and choose **Open with Live Server**.
4. In the browser tab, click **Start Microphone** and allow permission.

You can also host with any local HTTPS/localhost server.

## Browser support

Targeted for modern:

- Chromium / Edge
- Firefox
- Safari

## Troubleshooting

- **Mic permission denied**: Allow microphone access in browser site settings, then retry.
- **No microphone found**: Connect an input device and reload.
- **App loaded from insecure URL**: Microphone access requires HTTPS or localhost.
- **Meter not moving**: Check OS input device and browser input volume.

## Notes on loudness math

The app estimates loudness from the waveform using RMS:

1. Center each sample around 0.
2. Square each value.
3. Average the squares.
4. Take square root.

Then it applies:

- Sensitivity scaling
- Exponential moving average smoothing (to reduce visual jitter)
- Clamp to 0–100 for the UI meter
