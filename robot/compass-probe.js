// compass-probe.js — Test de la boussole I2C (QMC5883P @ 0x2C)
// Affiche l'ID de la puce + X/Y/Z + le cap en direct.
// Lance :  node compass-probe.js
'use strict';

const i2c = require('i2c-bus');
const ADDR = 0x2c;

const bus = i2c.openSync(1);

// 1) Identité de la puce (registre 0x00). QMC5883P doit répondre 0x80.
try {
  const id = bus.readByteSync(ADDR, 0x00);
  console.log('Chip ID (reg 0x00) = 0x' + id.toString(16),
    id === 0x80 ? '(QMC5883P ✓)' : '(à vérifier)');
} catch (e) {
  console.log('Lecture ID impossible :', e.message);
}

// 2) Init mode continu (valeurs typiques QMC5883P — on ajustera si besoin)
try {
  bus.writeByteSync(ADDR, 0x0B, 0x08); // Control 2 : set/reset activé
  bus.writeByteSync(ADDR, 0x0A, 0xC3); // Control 1 : continu, ODR/OSR/range
  console.log('Boussole initialisée. Tourne le robot lentement sur place 🧭');
} catch (e) {
  console.log('Init impossible :', e.message);
}

// 3) Lecture en boucle
setInterval(() => {
  try {
    const buf = Buffer.alloc(6);
    bus.readI2cBlockSync(ADDR, 0x01, 6, buf); // données à partir de 0x01
    const x = buf.readInt16LE(0);
    const y = buf.readInt16LE(2);
    const z = buf.readInt16LE(4);
    let cap = (Math.atan2(y, x) * 180) / Math.PI;
    if (cap < 0) cap += 360;
    console.log(`X=${x}  Y=${y}  Z=${z}   cap≈${cap.toFixed(0)}°`);
  } catch (e) {
    console.log('Lecture données impossible :', e.message);
  }
}, 500);
