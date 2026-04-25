// public/eeg-source.js
// Adapter-agnostic EEG source interface.
// Browser-side. Source selected by ?source=simulator|brainbit|myndband|epoc query param,
// or by the session record's eeg_device_code.
//
// Public interface:
//   async connect() / disconnect() / isConnected()
//   onSample(cb)              — subscribe to {t, channels: [...uV]} events
//   onStatus(cb)              — subscribe to 'connecting'|'connected'|'disconnected'|'error'
//   onQuality(cb)             — subscribe to {t, perChannel: [{name, quality_pct, contact}]} events
//   getProfile()              — returns {code, channel_count, channel_map, sample_rate_hz, frontal_available}
//   setStimulusMode(on, hz)   — simulator only, no-op on real hardware
//
// Sample shape: { t: <ms epoch>, channels: [...] }   length matches channel_map order
// Quality shape: { t, perChannel: [{name, quality_pct, contact: 'good'|'fair'|'poor'|'off'}] }

window.WellnessEEG = (function () {
  const SAMPLE_RATE_HZ = 250;  // Simulator default; real devices report their own rate

  function createSource(kind) {
    if (kind === 'epoc' || kind === 'epoc1' || kind === 'epoc14')  return new EmotivEPOCBridgeSource();
    if (kind === 'brainbit' || kind === 'bluetooth')               return new BluetoothEEGSource();
    if (kind === 'myndband')                                       return new BluetoothEEGSource();  // TODO: dedicated TGAM
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
    this._qualityCbs = new Set();
    this._qualityState = null;          // per-channel quality 0..100, drifts
    this._qualityTimer = null;
    this._timer = null;
    this._phase = 0;
    this._targetFreq = 10;
    this._stimulusActive = false;
    this._entrainmentStrength = 0;

    // Default to 4-channel BrainBit-style; switched at connect() if profile param set
    this._channelMap = ['O1', 'O2', 'T3', 'T4'];

    // Allow caller to override which device the simulator is mimicking,
    // so the popup tests against realistic channel counts (4ch BrainBit, 14ch EPOC)
    this.setSimulatedDevice = function (channelMap) {
      if (Array.isArray(channelMap) && channelMap.length > 0) {
        self._channelMap = channelMap.slice();
        self._qualityState = null;  // reset on device switch
      }
    };

    this.connect = async function () {
      if (self._connected) return;
      self._emitStatus('connecting');
      await new Promise(r => setTimeout(r, 300));
      self._connected = true;
      self._emitStatus('connected');
      self._startStream();
      self._startQualityStream();
    };

    this.disconnect = async function () {
      if (!self._connected) return;
      clearInterval(self._timer);
      self._timer = null;
      clearInterval(self._qualityTimer);
      self._qualityTimer = null;
      self._connected = false;
      self._emitStatus('disconnected');
    };

    this.isConnected = () => self._connected;
    this.getDeviceInfo = () => self._connected
      ? { name: 'Simulator-EEG', battery: 100, firmware: 'sim-1.0' } : null;

    this.getProfile = () => ({
      code: 'simulator',
      display_name: 'Simulator (' + self._channelMap.length + 'ch)',
      channel_count: self._channelMap.length,
      channel_map: self._channelMap.slice(),
      sample_rate_hz: SAMPLE_RATE_HZ,
      frontal_available: self._channelMap.some(c => /^(F|AF|FP)/i.test(c)),
    });

    this.setStimulusMode = function (active, targetHz) {
      self._stimulusActive = active;
      if (targetHz) self._targetFreq = targetHz;
    };

    this.onSample  = function (cb) { self._sampleCbs.add(cb);  return () => self._sampleCbs.delete(cb); };
    this.onStatus  = function (cb) { self._statusCbs.add(cb);  return () => self._statusCbs.delete(cb); };
    this.onQuality = function (cb) { self._qualityCbs.add(cb); return () => self._qualityCbs.delete(cb); };
    this._emitStatus = function (s) { for (const cb of self._statusCbs) { try { cb(s); } catch(e) {} } };

    // Synthetic per-channel quality emitter — ramps from "off" up to "good"
    // over ~3s after connect to mimic real electrode settling, then drifts
    // realistically. Lets us validate the popup + live monitor without hardware.
    this._startQualityStream = function () {
      const n = self._channelMap.length;
      self._qualityState = new Array(n).fill(5);
      const connectTime = Date.now();

      self._qualityTimer = setInterval(() => {
        const elapsed = (Date.now() - connectTime) / 1000;
        const baseTarget = elapsed < 3 ? 5 + (75 / 3) * elapsed : 80;
        const perChannel = [];
        for (let i = 0; i < n; i++) {
          const wobble = Math.sin(elapsed * 0.3 + i * 1.7) * 8;
          const target = baseTarget + wobble;
          // First-order lag toward target so values feel physical
          self._qualityState[i] += (target - self._qualityState[i]) * 0.25;
          const pct = Math.max(0, Math.min(100, Math.round(self._qualityState[i])));
          let contact = 'off';
          if (pct >= 75) contact = 'good';
          else if (pct >= 50) contact = 'fair';
          else if (pct >= 20) contact = 'poor';
          perChannel.push({ name: self._channelMap[i], quality_pct: pct, contact });
        }
        const report = { t: Date.now(), perChannel };
        for (const cb of self._qualityCbs) { try { cb(report); } catch(e) {} }
      }, 250);
    };

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
    this.onQuality = function (cb) { self._qualityCbs = self._qualityCbs || new Set(); self._qualityCbs.add(cb); return () => self._qualityCbs.delete(cb); };
    this._emitStatus = function (s) { for (const cb of self._statusCbs) { try { cb(s); } catch(e) {} } };
    this.getProfile = () => ({
      code: 'brainbit',
      display_name: 'BrainBit Flex',
      channel_count: 4,
      channel_map: ['O1', 'O2', 'T3', 'T4'],
      sample_rate_hz: 250,
      frontal_available: false,
    });

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

  // ─── Emotiv EPOC 1.0 (14-channel, USB HID via WebHID) ──────────────────
  //
  // The EPOC 1.0 ships with a small 2.4GHz USB dongle that presents itself
  // to the OS as a HID device. The headset transmits 32-byte encrypted
  // packets at 128Hz. Decryption is AES-ECB with a key derived from the
  // device's serial number (community-reverse-engineered, see openyou/emokit).
  //
  // Each packet contains:
  //   - a counter byte (0..127, used for ordering AND to identify which
  //     electrode's contact-quality value is reported in this packet)
  //   - 14 channels, each 14-bit signed, packed across bytes 1..27
  //   - a contact-quality value for one electrode (rotates through all 16
  //     positions across consecutive packets — full CQ map every 16 packets,
  //     i.e. ~125ms — well under our 1s quality reporting cadence)
  //
  // Channel order (matches the registry channel_map):
  //   AF3, F7, F3, FC5, T7, P7, O1, O2, P8, T8, FC6, F4, F8, AF4
  //
  // Voltage scale: 14-bit ADC ~0.51 µV/LSB (per Emokit specification)

  // ─── Emotiv EPOC 1.0 (via local Python bridge over WebSocket) ──────────
  //
  // The EPOC 1.0 uses a proprietary 2.4GHz dongle and AES-encrypted USB HID
  // packets. Browsers can't reliably handle that decryption + bit-parsing
  // pipeline cross-platform, so DreamSonic uses a small Python bridge program
  // (epoc-bridge/epoc_bridge.py) running on the operator's Mac. The bridge
  // does the dongle communication, decryption, and channel/quality decoding,
  // then exposes everything over a local WebSocket on port 8765.
  //
  // This adapter just connects to that WebSocket and forwards samples + quality
  // through the standard adapter interface — same shape as Simulator and BrainBit.
  //
  // To use the iPad as the operator console with the bridge on a separate Mac,
  // set localStorage['epoc_bridge_url'] = 'ws://your-mac.local:8765' and reconnect.
  function EmotivEPOCBridgeSource() {
    const self = this;
    this._connected = false;
    this._sampleCbs = new Set();
    this._statusCbs = new Set();
    this._qualityCbs = new Set();
    this._ws = null;
    this._reconnectDelay = 1000;
    this._wantOpen = false;
    this._profile = {
      code: 'epoc1',
      display_name: 'Emotiv EPOC 1.0',
      channel_count: 14,
      channel_map: ['F3','FC5','AF3','F7','T7','P7','O1','O2','P8','T8','F8','AF4','FC6','F4'],
      sample_rate_hz: 128,
      frontal_available: true,
    };

    function bridgeUrl() {
      const override = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('epoc_bridge_url') : null;
      return override || 'ws://localhost:8765';
    }

    this.connect = async function () {
      if (self._connected) return;
      self._wantOpen = true;
      self._emitStatus('connecting');
      return new Promise((resolve, reject) => {
        let settled = false;
        const tryOpen = () => {
          if (!self._wantOpen) return;
          let ws;
          try { ws = new WebSocket(bridgeUrl()); }
          catch (e) {
            if (!settled) { settled = true; self._emitStatus('error'); reject(e); }
            return;
          }
          self._ws = ws;
          ws.onopen = () => {
            self._connected = true;
            self._reconnectDelay = 1000;
            self._emitStatus('connected');
            if (!settled) { settled = true; resolve(); }
          };
          ws.onmessage = (ev) => {
            let msg; try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'profile' && msg.payload) {
              self._profile = Object.assign({}, self._profile, msg.payload);
            } else if (msg.type === 'sample' && msg.payload) {
              const sample = { t: msg.payload.t || Date.now(), channels: msg.payload.channels };
              for (const cb of self._sampleCbs) { try { cb(sample); } catch(e) {} }
            } else if (msg.type === 'quality' && msg.payload) {
              for (const cb of self._qualityCbs) { try { cb(msg.payload); } catch(e) {} }
            }
          };
          ws.onclose = () => {
            self._connected = false;
            self._emitStatus('disconnected');
            if (self._wantOpen) {
              self._reconnectDelay = Math.min(10000, self._reconnectDelay * 1.5);
              setTimeout(tryOpen, self._reconnectDelay);
            }
            if (!settled) {
              settled = true;
              reject(new Error(
                'Could not reach EPOC bridge at ' + bridgeUrl() +
                '. Make sure the bridge program is running on your Mac.'
              ));
            }
          };
          ws.onerror = () => { /* onclose will run; let it handle */ };
        };
        tryOpen();
      });
    };

    this.disconnect = async function () {
      self._wantOpen = false;
      if (self._ws) {
        try { self._ws.close(); } catch (e) {}
        self._ws = null;
      }
      if (self._connected) {
        self._connected = false;
        self._emitStatus('disconnected');
      }
    };

    this.isConnected = () => self._connected;
    this.onSample  = (cb) => { self._sampleCbs.add(cb);  return () => self._sampleCbs.delete(cb); };
    this.onStatus  = (cb) => { self._statusCbs.add(cb);  return () => self._statusCbs.delete(cb); };
    this.onQuality = (cb) => { self._qualityCbs.add(cb); return () => self._qualityCbs.delete(cb); };
    this.setStimulusMode = function () { /* no-op */ };
    this.getProfile = () => Object.assign({}, self._profile);
    this._emitStatus = function (s) { for (const cb of self._statusCbs) { try { cb(s); } catch(e) {} } };
  }

  return { createSource, computeBandPowers, SAMPLE_RATE_HZ, BANDS };
})();
