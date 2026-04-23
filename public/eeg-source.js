// public/eeg-source.js
// Adapter-agnostic EEG source interface.
// Browser-side. Chosen via ?source=simulator|bluetooth query param.
//
// Interface:
//   async connect() / disconnect() / isConnected()
//   onSample(cb), onStatus(cb)
//   setStimulusMode(active, targetHz)  // simulator only, no-op on bluetooth
//
// Sample shape: { t: <ms epoch>, channels: [o1, o2, t3, t4] }  (µV, 4ch, 250Hz)

window.WellnessEEG = (function () {
  const SAMPLE_RATE_HZ = 250;

  function createSource(kind) {
    if (kind === 'bluetooth') return new BluetoothEEGSource();
    return new SimulatorEEGSource();
  }

  const BANDS = {
    delta: [0.5, 4], theta: [4, 8], alpha: [8, 12],
    smr:   [12, 15], beta:  [15, 25], gamma: [30, 50],
  };

  // Cooley-Tukey radix-2 FFT. Length must be power of 2.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cRe = 1, cIm = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j], uIm = im[i + j];
          const vRe = re[i + j + len/2] * cRe - im[i + j + len/2] * cIm;
          const vIm = re[i + j + len/2] * cIm + im[i + j + len/2] * cRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + len/2] = uRe - vRe;
          im[i + j + len/2] = uIm - vIm;
          const nRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nRe;
        }
      }
    }
  }

  function computeBandPowers(samples, sampleRate) {
    const N = 512;
    if (samples.length < N) return null;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const start = samples.length - N;
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      re[i] = samples[start + i] * w;
    }
    fft(re, im);
    const binHz = sampleRate / N;
    const bandPowers = {};
    for (const [band, [lo, hi]] of Object.entries(BANDS)) {
      let p = 0;
      const loBin = Math.max(1, Math.floor(lo / binHz));
      const hiBin = Math.min(N / 2 - 1, Math.ceil(hi / binHz));
      for (let k = loBin; k <= hiBin; k++) {
        p += re[k] * re[k] + im[k] * im[k];
      }
      bandPowers[band] = p / (hiBin - loBin + 1);
    }
    return bandPowers;
  }

  // ─── Simulator ─────────────────────────────────────────────────────────
  function SimulatorEEGSource() {
    const self = this;
    this._connected = false;
    this._sampleCbs = new Set();
    this._statusCbs = new Set();
    this._timer = null;
    this._phase = 0;
    this._targetFreq = 10;
    this._stimulusActive = false;
    this._entrainmentStrength = 0;

    this.connect = async function () {
      if (self._connected) return;
      self._emitStatus('connecting');
      await new Promise(r => setTimeout(r, 300));
      self._connected = true;
      self._emitStatus('connected');
      self._startStream();
    };

    this.disconnect = async function () {
      if (!self._connected) return;
      clearInterval(self._timer);
      self._timer = null;
      self._connected = false;
      self._emitStatus('disconnected');
    };

    this.isConnected = () => self._connected;
    this.getDeviceInfo = () => self._connected
      ? { name: 'Simulator-EEG', battery: 100, firmware: 'sim-1.0' } : null;

    this.setStimulusMode = function (active, targetHz) {
      self._stimulusActive = active;
      if (targetHz) self._targetFreq = targetHz;
    };

    this.onSample = function (cb) { self._sampleCbs.add(cb); return () => self._sampleCbs.delete(cb); };
    this.onStatus = function (cb) { self._statusCbs.add(cb); return () => self._statusCbs.delete(cb); };
    this._emitStatus = function (s) { for (const cb of self._statusCbs) { try { cb(s); } catch(e) {} } };

    this._startStream = function () {
      const batchSize = 25;
      const intervalMs = 100;

      self._timer = setInterval(() => {
        const target = self._stimulusActive ? 1 : 0;
        self._entrainmentStrength += (target - self._entrainmentStrength) * 0.05;

        for (let i = 0; i < batchSize; i++) {
          const t = Date.now();
          const dt = 1 / SAMPLE_RATE_HZ;
          self._phase += 2 * Math.PI * self._targetFreq * dt;
          if (self._phase > 2 * Math.PI * 1000) self._phase -= 2 * Math.PI * 1000;

          const pink =
              Math.sin(self._phase * 0.3 + 1.1) * 8
            + Math.sin(self._phase * 0.8 + 2.7) * 6
            + Math.sin(self._phase * 1.5 + 0.4) * 4
            + (Math.random() - 0.5) * 3;

          const entrain = Math.sin(self._phase) * (5 + self._entrainmentStrength * 20);

          const alpha = Math.sin(2 * Math.PI * 10 * t / 1000) * 3;
          const beta  = Math.sin(2 * Math.PI * 18 * t / 1000) * 2;
          const theta = Math.sin(2 * Math.PI * 6 * t / 1000) * 3;

          const base = pink + entrain * 0.5 + alpha + beta + theta;
          const channels = [
            base + Math.sin(self._phase + 0.1) * 2,
            base + Math.sin(self._phase + 0.2) * 2,
            base * 0.85 + Math.sin(self._phase + 0.3) * 2,
            base * 0.85 + Math.sin(self._phase + 0.4) * 2,
          ];

          const sample = { t, channels };
          for (const cb of self._sampleCbs) { try { cb(sample); } catch(e) {} }
        }
      }, intervalMs);
    };
  }

  // ─── Web Bluetooth (BrainBit) ──────────────────────────────────────────
  // TODO(cap): Before going live with real hardware, replace the PLACEHOLDER
  // UUIDs below with the real BrainBit GATT values from https://sdk.brainbit.com
  // and verify the packet parser against BrainBit's documented frame format.
  function BluetoothEEGSource() {
    const self = this;
    this._connected = false;
    this._sampleCbs = new Set();
    this._statusCbs = new Set();
    this._device = null;
    this._server = null;
    this._service = null;
    this._characteristic = null;

    const BRAINBIT_SERVICE_UUID = 'b4e4a2c0-0000-0000-0000-BRAINBITSDK01';  // PLACEHOLDER
    const BRAINBIT_DATA_CHAR_UUID = 'b4e4a2c0-0000-0000-0000-BRAINBITSDK02'; // PLACEHOLDER

    this.connect = async function () {
      if (!navigator.bluetooth) {
        throw new Error('Web Bluetooth not supported. Use Chrome / Edge / Opera.');
      }
      self._emitStatus('connecting');
      try {
        self._device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'BrainBit' }],
          optionalServices: [BRAINBIT_SERVICE_UUID],
        });
        self._device.addEventListener('gattserverdisconnected', () => {
          self._connected = false;
          self._emitStatus('disconnected');
        });
        self._server = await self._device.gatt.connect();
        self._service = await self._server.getPrimaryService(BRAINBIT_SERVICE_UUID);
        self._characteristic = await self._service.getCharacteristic(BRAINBIT_DATA_CHAR_UUID);
        await self._characteristic.startNotifications();
        self._characteristic.addEventListener('characteristicvaluechanged', self._onPacket);
        self._connected = true;
        self._emitStatus('connected');
      } catch (err) {
        self._emitStatus('error');
        throw err;
      }
    };

    this.disconnect = async function () {
      try { if (self._characteristic) await self._characteristic.stopNotifications(); }
      catch (e) { /* ignore */ }
      if (self._device && self._device.gatt.connected) self._device.gatt.disconnect();
      self._connected = false;
      self._emitStatus('disconnected');
    };

    this.isConnected = () => self._connected;
    this.getDeviceInfo = () => self._device
      ? { name: self._device.name, battery: null, firmware: null } : null;

    this.setStimulusMode = () => { /* no-op for real hardware */ };

    this.onSample = function (cb) { self._sampleCbs.add(cb); return () => self._sampleCbs.delete(cb); };
    this.onStatus = function (cb) { self._statusCbs.add(cb); return () => self._statusCbs.delete(cb); };
    this._emitStatus = function (s) { for (const cb of self._statusCbs) { try { cb(s); } catch(e) {} } };

    // TODO(cap): BrainBit frame format — verify field order, bit depth,
    // samples-per-packet count against the official SDK documentation.
    this._onPacket = function (event) {
      const dv = event.target.value;
      const CHANNEL_COUNT = 4;
      const BYTES_PER_CHANNEL = 3;
      const channels = [];
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        const off = ch * BYTES_PER_CHANNEL;
        if (off + 2 >= dv.byteLength) break;
        let v = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16);
        if (v & 0x800000) v |= 0xff000000;
        channels.push(v * 0.0298);
      }
      const sample = { t: Date.now(), channels };
      for (const cb of self._sampleCbs) { try { cb(sample); } catch(e) {} }
    };
  }

  return { createSource, computeBandPowers, SAMPLE_RATE_HZ, BANDS };
})();
