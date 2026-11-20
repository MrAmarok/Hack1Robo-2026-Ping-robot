// Appel telephonique quand le robot VOIT quelqu'un en mode ABSENT.
//
// Pourquoi un vrai appel en plus de la notification : une notification se
// rate (telephone en silencieux, app fermee, cle Apple expiree le 24/09/2026),
// un appel sonne. Il est reserve au cas grave — une PERSONNE sur la photo,
// selon l'analyse de Claude — parce qu'un appel a 3 h du matin pour un chat,
// on le coupe au bout de deux jours, et ce jour-la la vraie alerte passe.
//
// Passe par l'API REST de Twilio avec fetch : pas de dependance a installer.
// Secrets dans /root/server/.env, lus A CHAQUE APPEL (meme raison que
// Telegram : le .env est charge apres ce module) :
//   TWILIO_ACCOUNT_SID   ACxxxxxxxx
//   TWILIO_AUTH_TOKEN    jeton du compte
//   TWILIO_FROM          numero Twilio, format +33...
//   ALERTE_APPEL_NUMERO  ton numero, format +33...
//   ALERTE_APPEL_CADENCE_MS  (facultatif) un appel max par periode, 10 min,
//                            tous robots confondus (un seul numero appele)
//
// Le reglage "appels coupes / actifs" est par robot, garde sur le disque :
// il doit survivre a un redeploiement, sinon les appels reviendraient seuls.

const fs = require('fs');
const path = require('path');

const FICHIER_REGLAGES = path.join(__dirname, 'appel-alerte.json');
// UN SEUL horodatage pour tous les robots : le numero appele est le meme
// (ALERTE_APPEL_NUMERO), et une cadence par code se contournait en changeant
// de code a chaque alerte.
let dernierAppel = 0;

let coupes = new Set(); // codes pour lesquels l'utilisateur a coupe les appels
try {
  const lu = JSON.parse(fs.readFileSync(FICHIER_REGLAGES, 'utf8'));
  if (Array.isArray(lu.coupes)) coupes = new Set(lu.coupes.map(String));
} catch {
  // Premier demarrage : appels actifs par defaut, ce n'est pas une erreur.
}

function sauver() {
  try {
    fs.writeFileSync(FICHIER_REGLAGES, JSON.stringify({ coupes: Array.from(coupes) }));
  } catch (e) {
    console.log('[APPEL] reglage non enregistre :', e.message);
  }
}

function configure() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM &&
    process.env.ALERTE_APPEL_NUMERO
  );
}

function etatAppel(code) {
  return { actif: !coupes.has(String(code)), configure: configure() };
}

function reglerAppel(code, actif) {
  if (actif) coupes.delete(String(code));
  else coupes.add(String(code));
  sauver();
  return etatAppel(code);
}

// La phrase de Claude finit dans du XML lu par Twilio : sans echappement, un
// "<" ou un "&" dans la description casserait l'appel entier.
function xml(t) {
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Ne JAMAIS attendre ce resultat dans le chemin de l'alerte : un appel qui
// echoue ou traine ne doit retarder ni Telegram ni la notification.
async function appelerAlerte({ code, heure, phrase, log = console.log }) {
  const c = String(code);
  if (coupes.has(c)) {
    log(`[APPEL] ${c} : appels coupes par l'utilisateur, pas d'appel.`);
    return false;
  }
  if (!configure()) {
    log('[APPEL] non configure (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM / ALERTE_APPEL_NUMERO absents du .env).');
    return false;
  }
  // Un seul appel par incident : une personne qui traverse la maison
  // declenche une alerte toutes les 30 s, pas question d'appeler a chaque fois.
  const cadence = Number(process.env.ALERTE_APPEL_CADENCE_MS || 600000);
  const t = Date.now();
  const avant = dernierAppel;
  if (avant && t - avant < cadence) {
    log(`[APPEL] ${c} : deja appele il y a ${Math.round((t - avant) / 1000)} s, pas de nouvel appel.`);
    return false;
  }
  // Note AVANT l'envoi : deux alertes rapprochees ne doivent pas passer
  // toutes les deux pendant que la premiere requete est en vol.
  dernierAppel = t;

  const message =
    // Accents gardes : c'est une voix qui lit, "ete" se prononcerait mal.
    `Alerte du robot. Quelqu'un a été vu dans la maison à ${heure}. ` +
    (phrase ? `${phrase} ` : '') +
    "La photo est dans l'application.";
  // De preference, l'appel est branche sur l'assistant (appel-direct.js) : on
  // lui parle, il regarde, il agit. Le message lu ne sert plus que de repli,
  // si la conversation est impossible (cle OpenAI absente, pas de HTTPS).
  const twiml =
    require('./appel-direct').twimlConversation({ code: c, heure, phrase, log }) ||
    // Dit deux fois : le premier passage tombe souvent pendant qu'on decroche.
    '<Response>' +
    `<Say language="fr-FR" voice="Polly.Lea">${xml(message)}</Say>` +
    '<Pause length="1"/>' +
    `<Say language="fr-FR" voice="Polly.Lea">${xml(message)}</Say>` +
    '</Response>';

  const r = await lancerAppelTwilio({ to: process.env.ALERTE_APPEL_NUMERO, twiml, log });
  if (!r.ok) {
    // Echec : on libere la cadence, sinon une panne passagere de Twilio
    // empecherait tout appel pendant 10 minutes.
    if (dernierAppel === t) dernierAppel = 0;
    return false;
  }
  log(`[APPEL] ${c} : appel lance (${r.sid || 'sans identifiant'}).`);
  return true;
}

// Passe un appel Twilio. Partage par l'alerte et par l'outil qui previent un
// proche : une seule facon de parler a Twilio, une seule a corriger.
async function lancerAppelTwilio({ to, twiml, log = console.log }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Twiml: twiml }).toString(),
      signal: ctrl.signal,
    });
    clearTimeout(minuteur);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      log(`[APPEL] refus Twilio (HTTP ${r.status}) : ${j.message || 'sans detail'}`);
      return { ok: false };
    }
    return { ok: true, sid: j.sid };
  } catch (e) {
    log('[APPEL] appel impossible :', e.message);
    return { ok: false };
  }
}

module.exports = { appelerAlerte, etatAppel, reglerAppel, lancerAppelTwilio, xml };
