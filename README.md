# MAGNETIC UI — The Magnetic Website

A futuristic, responsive web experiment that makes the interface react to changes in a real magnetic field.

**Live website:** https://atbeenlabs.github.io/MAGNETIC-UI/  
**Source:** https://github.com/AtbeenLabs/MAGNETIC-UI  
**Maintainer:** [AtbeenLabs](https://github.com/AtbeenLabs)

## Modes

- **REAL SENSOR** — reads X, Y and Z from the browser Generic Sensor API when a real magnetometer is exposed and permission is granted.
- **DEMO MODE** — mouse and touch simulate a magnetic force for visual testing. Demo input is kept separate from real sensor telemetry.
- **UNSUPPORTED** — clearly reports when the current browser/device does not expose a usable sensor.

## Features

- Ambient magnetic-field baseline and live vector-delta telemetry.
- Guided four-direction calibration saved in local storage.
- Estimated screen direction and reaction strength.
- Spring/damping physics with force, sensitivity, smoothness and inversion controls.
- Optional USB Serial and Bluetooth LE bridges for supported external sensors.
- Responsive dark interface, reduced-motion support and no required backend.

## Run locally

Clone this repository, enter the folder, then run:

    python3 -m http.server 8000

Open http://localhost:8000. The visual demo works without a magnetometer.

Run the calibration tests with Node.js:

    npm test

## Real sensor requirements

- Use HTTPS in production. Localhost is generally treated as a secure context by modern browsers.
- Sensor access depends on device hardware, browser support, permissions and Permissions Policy.
- A magnetometer reports a magnetic-field vector; it does **not** directly report the magnet's screen position or distance. Direction is estimated from changes relative to the baseline and improved through calibration.
- Demo pointer movement is never labelled as real magnet detection.

## Project structure

- index.html — application entry point.
- styles.css — responsive visual design.
- src/sensor.js — sensor detection, permissions and external bridges.
- src/calibration.js — baseline and direction mapping.
- src/physics.js — spring motion.
- src/main.js — UI and application lifecycle.
- tests/ — calibration tests.

## Deployment

GitHub Actions publishes this repository to GitHub Pages on pushes to main.

## License

Project source code is provided under the MIT License in LICENSE.
