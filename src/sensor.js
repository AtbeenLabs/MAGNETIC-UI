function normalizeReading(value) {
  const reading = {
    x: Number(value?.x),
    y: Number(value?.y),
    z: Number(value?.z),
  };
  if (![reading.x, reading.y, reading.z].every(Number.isFinite)) {
    throw new TypeError('The sensor packet must contain finite numeric x, y and z values.');
  }
  return reading;
}

export function getSensorCapabilities() {
  const hasUncalibrated = typeof window !== 'undefined' && 'UncalibratedMagnetometer' in window;
  const hasMagnetometer = typeof window !== 'undefined' && 'Magnetometer' in window;
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  return {
    secure,
    builtInMagnetometer: hasUncalibrated || hasMagnetometer,
    uncalibratedMagnetometer: hasUncalibrated,
    usbSerial: typeof navigator !== 'undefined' && 'serial' in navigator,
    bluetoothLE: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
  };
}

export class SensorHub {
  constructor({ onReading = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
    this.onReading = onReading;
    this.onStatus = onStatus;
    this.onError = onError;
    this.sensor = null;
    this.serialPort = null;
    this.serialReader = null;
    this.bleDevice = null;
    this.bleCharacteristic = null;
    this.source = null;
    this.firstReadingTimer = null;
    this.closed = false;
  }

  notifyStatus(state, source = this.source) {
    this.onStatus({ state, source });
  }

  emitReading(value, source, kind) {
    const reading = normalizeReading(value);
    this.source = source;
    if (this.firstReadingTimer) {
      clearTimeout(this.firstReadingTimer);
      this.firstReadingTimer = null;
    }
    this.notifyStatus('connected', source);
    this.onReading({ ...reading, source, kind, timestamp: performance.now() });
  }

  armFirstReadingTimeout(source) {
    if (this.firstReadingTimer) clearTimeout(this.firstReadingTimer);
    this.firstReadingTimer = setTimeout(() => {
      this.firstReadingTimer = null;
      this.onError(new Error(`The ${source} connection opened, but no valid sensor reading arrived. Check the sensor and its output format.`));
      this.stop().catch(() => {});
    }, 4500);
  }

  async startBuiltIn() {
    await this.stop();
    const capabilities = getSensorCapabilities();
    if (!capabilities.secure) {
      throw new Error('A secure context is required. Open this site over HTTPS (GitHub Pages is HTTPS) or localhost.');
    }
    if (!capabilities.builtInMagnetometer) {
      throw new Error('This browser does not expose the Magnetometer API. Try a compatible mobile browser or connect an external sensor.');
    }

    let sensor;
    let kind = 'calibrated';
    try {
      if (capabilities.uncalibratedMagnetometer) {
        sensor = new window.UncalibratedMagnetometer({ frequency: 25, referenceFrame: 'screen' });
        kind = 'uncalibrated';
      } else {
        sensor = new window.Magnetometer({ frequency: 25, referenceFrame: 'screen' });
      }
    } catch (error) {
      try {
        sensor = new window.Magnetometer({ frequency: 20 });
        kind = 'calibrated';
      } catch (fallbackError) {
        throw fallbackError ?? error;
      }
    }

    this.sensor = sensor;
    this.source = 'built-in';
    this.closed = false;
    this.notifyStatus('connecting', 'built-in');
    sensor.addEventListener('reading', () => {
      try {
        this.emitReading({ x: sensor.x, y: sensor.y, z: sensor.z }, 'built-in', kind);
      } catch (error) {
        this.onError(error);
      }
    });
    sensor.addEventListener('error', (event) => {
      const error = event.error ?? new Error('The device sensor failed.');
      this.onError(this.describeSensorError(error));
      this.stop().catch(() => {});
    });

    try {
      sensor.start();
    } catch (error) {
      this.sensor = null;
      throw this.describeSensorError(error);
    }
    this.armFirstReadingTimeout('built-in magnetometer');
  }

  describeSensorError(error) {
    const name = error?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new Error('Sensor permission was denied or blocked by Permissions Policy. Allow magnetometer access and try again.');
    }
    if (name === 'NotReadableError') return new Error('The magnetometer is unavailable or is already in use by another application.');
    if (name === 'AbortError') return new Error('The sensor could not be started.');
    return new Error(error?.message || 'The sensor is unavailable on this device.');
  }

  async connectSerial() {
    if (!('serial' in navigator)) throw new Error('Web Serial is not available in this browser. Try a Chromium-based desktop browser over HTTPS.');
    if (!window.isSecureContext) throw new Error('USB Serial access requires HTTPS or localhost.');

    // Open the picker before awaiting cleanup so the browser still sees the direct user gesture.
    const portRequest = navigator.serial.requestPort();
    await this.stop();
    const port = await portRequest;
    await port.open({ baudRate: 115200 });
    this.serialPort = port;
    if (!port.readable) throw new Error('The selected serial device has no readable stream.');
    this.serialReader = port.readable.getReader();
    this.source = 'usb-serial';
    this.closed = false;
    this.notifyStatus('connecting', 'usb-serial');
    this.armFirstReadingTimeout('USB serial sensor');
    this.readSerialStream(this.serialReader).catch((error) => {
      if (!this.closed) this.onError(new Error(`USB serial connection ended: ${error.message}`));
    });
  }

  async readSerialStream(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16384) buffer = buffer.slice(-8192);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const payload = JSON.parse(line);
            this.emitReading(payload, 'usb-serial', 'external-json');
          } catch (error) {
            if (error instanceof SyntaxError) this.onError(new Error('USB packet was not valid JSON. Expected one JSON object per line with x, y and z numbers.'));
            else this.onError(error);
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (!this.closed && this.source === 'usb-serial') this.notifyStatus('disconnected', 'usb-serial');
    }
  }

  async connectBluetooth(serviceUuid, characteristicUuid) {
    if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth is not available in this browser.');
    if (!window.isSecureContext) throw new Error('Bluetooth access requires HTTPS or localhost.');
    if (!serviceUuid?.trim() || !characteristicUuid?.trim()) throw new Error('Enter both the BLE service UUID and characteristic UUID.');

    // Open the browser picker before awaiting cleanup to preserve the user activation.
    const deviceRequest = navigator.bluetooth.requestDevice({ filters: [{ services: [serviceUuid.trim()] }] });
    await this.stop();
    const device = await deviceRequest;
    this.bleDevice = device;
    this.source = 'bluetooth-le';
    this.closed = false;
    this.notifyStatus('connecting', 'bluetooth-le');
    device.addEventListener('gattserverdisconnected', () => {
      if (!this.closed) this.notifyStatus('disconnected', 'bluetooth-le');
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(serviceUuid.trim());
    const characteristic = await service.getCharacteristic(characteristicUuid.trim());
    this.bleCharacteristic = characteristic;
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      try {
        const dataView = event.target.value;
        const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        const text = new TextDecoder().decode(bytes).trim();
        this.emitReading(JSON.parse(text), 'bluetooth-le', 'external-json');
      } catch (error) {
        this.onError(new Error(`BLE reading must be a UTF-8 JSON object with x, y and z: ${error.message}`));
      }
    });
    await characteristic.startNotifications();
    this.armFirstReadingTimeout('Bluetooth LE sensor');
  }

  async stop() {
    this.closed = true;
    if (this.firstReadingTimer) clearTimeout(this.firstReadingTimer);
    this.firstReadingTimer = null;

    if (this.sensor) {
      try { this.sensor.stop(); } catch { /* sensor may already be stopped */ }
      this.sensor = null;
    }
    if (this.serialReader) {
      try { await this.serialReader.cancel(); } catch { /* port may have closed */ }
      this.serialReader = null;
    }
    if (this.serialPort) {
      try { await this.serialPort.close(); } catch { /* close can race with stream shutdown */ }
      this.serialPort = null;
    }
    if (this.bleDevice?.gatt?.connected) {
      try { this.bleDevice.gatt.disconnect(); } catch { /* device may have disconnected */ }
    }
    this.bleDevice = null;
    this.bleCharacteristic = null;
    this.source = null;
    this.notifyStatus('disconnected', null);
  }
}
