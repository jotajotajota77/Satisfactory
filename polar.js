/* ============================================================
   Conexão com sensores Polar via Web Bluetooth.
   - Frequência cardíaca (FC) + intervalos RR (HRV): Heart Rate Service.
   - Acelerômetro / giroscópio: Polar Measurement Data (PMD) service.
   Expõe window.Bio.data, lido pelo ecossistema (app.js).
   Requer HTTPS + gesto do usuário. Indisponível em iOS/Firefox.
   ============================================================ */
(function () {
  'use strict';

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  // Polar Measurement Data (PMD) — service proprietária
  var PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
  var PMD_CTRL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
  var PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';
  // start ACC (200Hz, 16 bit, ±8G) e GYRO (52Hz, 16 bit, 2000 dps)
  var START_ACC = new Uint8Array([0x02, 0x02, 0x00, 0x01, 0xC8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
  var START_GYRO = new Uint8Array([0x02, 0x05, 0x00, 0x01, 0x34, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0xD0, 0x07]);

  var data = {
    connected: false, hr: 0, hrv: 0,
    accMag: 0, gyroMag: 0, gyroZ: 0,
    accOn: false, gyroOn: false,
    beats: 0, lastBeatAt: 0,
  };

  var device = null;
  var accGravEMA = 1000; // baseline ~1G (auto-calibrado na 1ª amostra)
  var accInit = false;
  var gyroScale = 1;
  var rrBuf = [];
  var lastTele = 0;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // --- DOM (botão + leitura) ---
  var btn = document.getElementById('bio-btn');
  var readout = document.getElementById('bio');
  var tele = document.getElementById('bio-telemetry');
  var heartEl = btn ? btn.querySelector('.bio-heart') : null;
  function setStatus(t) { if (readout) readout.textContent = t; }
  function updateTelemetry(force) {
    if (!tele) return;
    var now = (performance && performance.now) ? performance.now() : Date.now();
    if (!force && now - lastTele < 250) return;
    lastTele = now;
    if (!data.connected) { tele.textContent = ''; return; }
    var parts = [];
    if (data.hr) parts.push('♥ ' + data.hr);
    parts.push('mov ' + (data.accOn ? Math.round(data.accMag * 100) + '%' : '—'));
    parts.push('giro ' + (data.gyroOn ? Math.round(data.gyroMag * 100) + '%' : '—'));
    tele.textContent = parts.join('  ·  ');
  }
  function pulseHeart() {
    if (!heartEl) return;
    heartEl.classList.remove('beat');
    // força reflow para reiniciar a animação
    void heartEl.offsetWidth;
    heartEl.classList.add('beat');
  }

  // --- leitura de bits (PMD usa empacotamento little-endian, LSB primeiro) ---
  function readBits(bytes, bitOffset, size) {
    var val = 0;
    for (var i = 0; i < size; i++) {
      var bo = bitOffset + i;
      var bit = (bytes[bo >> 3] >> (bo & 7)) & 1;
      val |= bit << i;
    }
    return val;
  }
  function readBitsSigned(bytes, bitOffset, size) {
    var v = readBits(bytes, bitOffset, size);
    if (v & (1 << (size - 1))) v -= (1 << size);
    return v;
  }

  // decodifica frames PMD (raw ou delta) em amostras [ch0,ch1,ch2,...]
  function decodeFrames(bytes, channels, frameType) {
    var out = [];
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (frameType === 0) {
      var step = channels * 2;
      for (var o = 0; o + step <= bytes.byteLength; o += step) {
        var s = [];
        for (var c = 0; c < channels; c++) s.push(dv.getInt16(o + c * 2, true));
        out.push(s);
      }
      return out;
    }
    // delta: amostra de referência (int16 por canal) + blocos comprimidos
    var off = 0;
    var ref = [];
    for (var rc = 0; rc < channels; rc++) { ref.push(dv.getInt16(off, true)); off += 2; }
    out.push(ref.slice());
    var bit = off * 8;
    var total = bytes.byteLength * 8;
    while (bit + 16 <= total) {
      var deltaSize = readBits(bytes, bit, 8); bit += 8;
      var count = readBits(bytes, bit, 8); bit += 8;
      if (!deltaSize || !count) break;
      for (var s2 = 0; s2 < count; s2++) {
        if (bit + channels * deltaSize > total) { bit = total; break; }
        for (var c2 = 0; c2 < channels; c2++) {
          ref[c2] += readBitsSigned(bytes, bit, deltaSize); bit += deltaSize;
        }
        out.push(ref.slice());
      }
    }
    return out;
  }

  function onPMD(e) {
    try {
      var v = e.target.value;
      if (v.byteLength < 11) return;
      var type = v.getUint8(0);
      var frameType = v.getUint8(9);
      var bytes = new Uint8Array(v.buffer, v.byteOffset + 10, v.byteLength - 10);
      var samples = decodeFrames(bytes, 3, frameType);
      if (!samples.length) return;
      var i, sum = 0;
      if (type === 0x02) {        // ACC — usa a amostra de referência (decodificação confiável)
        var ref = samples[0];
        var mag = Math.hypot(ref[0], ref[1], ref[2]);
        if (!accInit) { accGravEMA = mag; accInit = true; } // calibra o repouso na 1ª amostra
        var dev = Math.abs(mag - accGravEMA);
        accGravEMA = lerp(accGravEMA, mag, 0.05);           // baseline ~1G acompanha a postura
        var scale = Math.max(accGravEMA * 0.5, 1);          // normaliza por ~1G (independe da unidade)
        data.accMag = lerp(data.accMag, clamp(dev / scale, 0, 1), 0.5);
        data.accOn = true;
        updateTelemetry();
      } else if (type === 0x05) { // GYRO (não existe no H10)
        var sz = 0, gmax = 1;
        for (i = 0; i < samples.length; i++) { sz += samples[i][2]; sum += Math.hypot(samples[i][0], samples[i][1], samples[i][2]); }
        gyroScale = Math.max(gyroScale * 0.999, (sum / samples.length));
        data.gyroZ = clamp((sz / samples.length) / Math.max(gyroScale, gmax), -1, 1);
        data.gyroMag = clamp((sum / samples.length) / Math.max(gyroScale, gmax), 0, 1);
        data.gyroOn = true;
        updateTelemetry();
      }
    } catch (err) { /* frame inesperado: ignora */ }
  }

  function pushRR(rr) {
    rrBuf.push(rr);
    if (rrBuf.length > 30) rrBuf.shift();
    if (rrBuf.length > 3) {
      var sq = 0;
      for (var i = 1; i < rrBuf.length; i++) { var d = rrBuf[i] - rrBuf[i - 1]; sq += d * d; }
      data.hrv = Math.sqrt(sq / (rrBuf.length - 1));
    }
  }

  // dispara um batimento respeitando um período refratário (evita QRS duplicado)
  function fireBeat() {
    var now = (performance && performance.now) ? performance.now() : Date.now();
    if (now - data.lastBeatAt < 250) return;
    data.beats++; data.lastBeatAt = now; pulseHeart();
  }

  function onHR(e) {
    var v = e.target.value;
    var flags = v.getUint8(0);
    var idx = 1, hr;
    if (flags & 0x01) { hr = v.getUint16(idx, true); idx += 2; } else { hr = v.getUint8(idx); idx += 1; }
    if (flags & 0x08) idx += 2; // energia gasta
    var rrs = [];
    if (flags & 0x10) {
      for (; idx + 2 <= v.byteLength; idx += 2) rrs.push(v.getUint16(idx, true) / 1024 * 1000);
    }
    data.hr = hr;
    setStatus('♥ ' + hr);
    updateTelemetry(true);
    // batidas: agenda pelos intervalos RR (mais fiel) ou uma por notificação
    if (rrs.length) {
      var acc = 0;
      for (var i = 0; i < rrs.length; i++) {
        pushRR(rrs[i]);
        acc += rrs[i];
        setTimeout(fireBeat, Math.max(0, acc - rrs[0]));
      }
    } else {
      fireBeat();
    }
  }

  async function startPMD(server) {
    var svc = await server.getPrimaryService(PMD_SERVICE);
    var ctl = await svc.getCharacteristic(PMD_CTRL);
    var dataCh = await svc.getCharacteristic(PMD_DATA);
    await dataCh.startNotifications();
    dataCh.addEventListener('characteristicvaluechanged', onPMD);
    try { await ctl.startNotifications(); } catch (e) {}
    var write = function (cmd) {
      return ctl.writeValueWithResponse ? ctl.writeValueWithResponse(cmd) : ctl.writeValue(cmd);
    };
    // a Polar precisa de uma pausa entre comandos de medição
    try { await write(START_ACC); } catch (e) {}
    await sleep(500);
    try { await write(START_GYRO); } catch (e) {} // só Verity Sense etc.
  }

  function onDisconnected() {
    data.connected = false;
    data.accOn = false; data.gyroOn = false;
    data.accMag = 0; accInit = false;
    if (btn) btn.classList.remove('on');
    setStatus('♥ conectar');
    updateTelemetry(true);
  }

  async function connect() {
    if (!navigator.bluetooth) { setStatus('Bluetooth indisponível'); return; }
    accInit = false;
    try {
      setStatus('procurando…');
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar' }, { services: ['heart_rate'] }],
        optionalServices: ['heart_rate', PMD_SERVICE, 'battery_service'],
      });
      device.addEventListener('gattserverdisconnected', onDisconnected);
      setStatus('conectando…');
      var server = await device.gatt.connect();
      try {
        var hrSvc = await server.getPrimaryService('heart_rate');
        var hrCh = await hrSvc.getCharacteristic('heart_rate_measurement');
        await hrCh.startNotifications();
        hrCh.addEventListener('characteristicvaluechanged', onHR);
      } catch (e) { /* sem FC */ }
      try { await startPMD(server); } catch (e) { /* sem acc/gyro */ }
      data.connected = true;
      if (btn) btn.classList.add('on');
      setStatus('♥ --');
    } catch (e) {
      setStatus(e && e.name === 'NotFoundError' ? '♥ conectar' : 'falhou');
    }
  }

  function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    onDisconnected();
  }

  if (btn) {
    if (!navigator.bluetooth) {
      btn.classList.add('unsupported');
      setStatus('♥ indisponível');
    }
    btn.addEventListener('click', function () {
      if (data.connected) disconnect(); else connect();
    });
  }

  window.Bio = { data: data, connect: connect, disconnect: disconnect, supported: !!navigator.bluetooth };
})();
