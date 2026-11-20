// compass.js — Boussole QMC5883P (I2C @ 0x2C) pour le robot Ping
// Donne un cap (0-360°, 0 = Nord) précis pour la navigation.
//
// Calibration (À FAIRE UNE FOIS) :  node compass.js calibrate
//   -> fais tourner le robot lentement sur lui-même ~25 s (plusieurs tours)
//   -> enregistre les offsets dans compass-cal.json
'use strict';

const fs = require('fs');
const path = require('path');
const i2c = require('i2c-bus');

const ADDR = 0x2c;
const CAL_FILE = path.join(__dirname, 'compass-cal.json');

function initSensor(bus) {
  bus.writeByteSync(ADDR, 0x0B, 0x08); // Control 2 : set/reset
  bus.writeByteSync(ADDR, 0x0A, 0xC3); // Control 1 : mode continu
}

class Compass {
  constructor({ log, declination } = {}) {
    this.log = log || console.log;
    this.declination = Number(declination) || 0; // offset Nord + montage (réglable)
    // Inverse le sens de rotation de la boussole (si le robot tourne en rond)
    this.invert = process.env.COMPASS_INVERT === '1' || process.env.COMPASS_INVERT === 'true';
    this.bus = null;
    this.ok = false;
    this.cal = { offX: 0, offY: 0, scaleX: 1, scaleY: 1 };
    // Lissage (filtre passe-bas) pour réduire le bruit des moteurs.
    // 1 = aucun lissage, plus petit = plus lisse mais plus de latence.
    this.alpha = Number(process.env.COMPASS_SMOOTH || 0.4);
    this.sx = null;
    this.sy = null;
  }

  loadCal() {
    try {
      if (fs.existsSync(CAL_FILE)) {
        this.cal = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        this.log('🧭 Calibration boussole chargée.');
      } else {
        this.log('⚠️  Boussole NON calibrée — lance : node compass.js calibrate');
      }
    } catch (e) {
      this.log('Calibration illisible :', e.message);
    }
  }

  start() {
    try {
      this.bus = i2c.openSync(1);
      initSensor(this.bus);
      this.loadCal();
      this.ok = true;
      this.log('🧭 Boussole prête.');
    } catch (e) {
      this.ok = false;
      this.log('⚠️  Boussole indisponible :', e.message);
    }
  }

  readRaw() {
    const buf = Buffer.alloc(6);
    this.bus.readI2cBlockSync(ADDR, 0x01, 6, buf);
    return { x: buf.readInt16LE(0), y: buf.readInt16LE(2), z: buf.readInt16LE(4) };
  }

  // Cap en degrés (0 = Nord), ou null si indisponible
  getHeading() {
    if (!this.ok) return null;
    try {
      const r = this.readRaw();
      let x = (r.x - this.cal.offX) * (this.cal.scaleX || 1);
      let y = (r.y - this.cal.offY) * (this.cal.scaleY || 1);
      // Filtre passe-bas sur le vecteur (gère le passage 360->0 sans à-coup)
      const a = this.alpha;
      this.sx = this.sx == null ? x : a * x + (1 - a) * this.sx;
      this.sy = this.sy == null ? y : a * y + (1 - a) * this.sy;
      x = this.sx;
      y = this.sy;
      let deg = (Math.atan2(y, x) * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      if (this.invert) deg = (360 - deg) % 360; // inverse le sens si besoin
      let h = ((deg + this.declination) % 360 + 360) % 360;
      return h;
    } catch {
      return null;
    }
  }
}

// ---- Mode calibration ----
function calibrate() {
  const bus = i2c.openSync(1);
  initSensor(bus);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  console.log('CALIBRATION : fais tourner le robot LENTEMENT sur lui-meme,');
  console.log('plusieurs tours complets, pendant 25 secondes...');
  const t0 = Date.now();
  const iv = setInterval(() => {
    const buf = Buffer.alloc(6);
    bus.readI2cBlockSync(ADDR, 0x01, 6, buf);
    const x = buf.readInt16LE(0), y = buf.readInt16LE(2);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    process.stdout.write(`\rX[${minX}..${maxX}]  Y[${minY}..${maxY}]   `);
    if (Date.now() - t0 > 25000) {
      clearInterval(iv);
      const offX = (minX + maxX) / 2;
      const offY = (minY + maxY) / 2;
      const sx = Math.max(1, (maxX - minX) / 2);
      const sy = Math.max(1, (maxY - minY) / 2);
      const avg = (sx + sy) / 2;
      const cal = { offX, offY, scaleX: avg / sx, scaleY: avg / sy };
      fs.writeFileSync(CAL_FILE, JSON.stringify(cal, null, 2));
      console.log('\n✅ Calibration enregistree dans compass-cal.json :');
      console.log(cal);
      process.exit(0);
    }
  }, 100);
}

if (require.main === module && process.argv[2] === 'calibrate') {
  calibrate();
}

module.exports = { Compass };
