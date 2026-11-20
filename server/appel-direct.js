// appel-direct.js - L'appel d'alerte devient une CONVERSATION avec l'assistant.
//
// Avant : Twilio lisait un message et raccrochait. Maintenant, quand on
// decroche, Twilio ouvre un flux audio vers le VPS (Media Streams). On le
// branche sur la meme session OpenAI Realtime que la conversation du robot
// (realtime-voix.js) : meme personnalite, memes outils (regarder, piloter,
// bouger la camera...), plus trois outils propres au telephone : la sirene,
// parler a l'intrus par le haut-parleur du robot, et prevenir un proche.
//
// Chemin du son :
//   telephone <-> Twilio <-> wss://api.ping-app.org/ping/twilio-flux
//   (nginx : /ping/ -> 127.0.0.1:3000) <-> ce module <-> OpenAI Realtime
// Twilio parle en mu-law 8 kHz, que la Realtime accepte telle quelle
// (audio/pcmu) : aucune conversion, donc aucun retard ajoute.
//
// SECOURS : l'assistant ne peut PAS appeler le 17 ou le 112. Twilio
// l'interdit, et une IA qui se trompe (un reflet, un proche qui a les cles)
// enverrait de fausses alertes aux secours. Il dit a l'utilisateur de les
// appeler lui-meme et lui donne quoi dire ; il peut prevenir un proche.
//
// Reglages (.env) : OPENAI_API_KEY (obligatoire), et facultatifs :
//   APPEL_FLUX_URL     adresse wss du flux (defaut : PUBLIC_URL + /ping/twilio-flux)
//   APPEL_DUREE_MAX_MS duree maximale d'un appel (defaut : 10 min)
//   PROCHE_NUMERO      +33... : active l'outil prevenir_proche
//   PROCHE_NOM         son prenom, pour que l'assistant le nomme
//   ADRESSE_MAISON     dictee aux secours et au proche
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');
const { SessionVocale } = require('./realtime-voix');

const DOSSIER_ALERTES = '/root/server/alertes';
const CHEMIN_FLUX = '/twilio-flux';
// Un appel oublie ouvert facture de l'audio a la minute, des deux cotes.
const DUREE_MAX_MS = () => Number(process.env.APPEL_DUREE_MAX_MS || 600000);

// Jetons a usage unique : seul un appel que NOUS avons lance peut ouvrir une
// conversation. Sans eux, quiconque trouve l'adresse du flux parlerait a
// l'assistant — et pourrait declencher la sirene ou faire rouler le robot.
const attentes = new Map(); // jeton -> { code, heure, phrase, expire }
const VALIDITE_JETON_MS = 10 * 60 * 1000;

function xml(t) {
  return require('./appel-alerte').xml(t);
}

function urlFlux() {
  if (process.env.APPEL_FLUX_URL) return process.env.APPEL_FLUX_URL;
  const base = process.env.PUBLIC_URL || 'https://api.ping-app.org';
  return base.replace(/^http/, 'ws').replace(/\/$/, '') + '/ping' + CHEMIN_FLUX;
}

// TwiML qui branche l'appel sur l'assistant, ou null si c'est impossible
// (l'appelant retombe alors sur le message lu).
function twimlConversation({ code, heure, phrase, log = console.log }) {
  if (!process.env.OPENAI_API_KEY) {
    log('[TEL] OPENAI_API_KEY absente : appel en message lu, sans conversation.');
    return null;
  }
  const url = urlFlux();
  // Twilio n'accepte qu'un flux chiffre.
  if (!url.startsWith('wss://')) {
    log(`[TEL] adresse de flux non chiffree (${url}) : appel en message lu.`);
    return null;
  }
  const t = Date.now();
  for (const [j, a] of attentes) if (a.expire < t) attentes.delete(j);
  const jeton = crypto.randomBytes(16).toString('hex');
  attentes.set(jeton, { code: String(code), heure, phrase, expire: t + VALIDITE_JETON_MS });
  return (
    '<Response><Connect>' +
    `<Stream url="${xml(url)}"><Parameter name="jeton" value="${jeton}"/></Stream>` +
    '</Connect></Response>'
  );
}

// Outils propres au telephone. Ceux du robot (regarder, piloter...) viennent
// deja de voice-brain.js par la session.
function outilsTelephone({ io, code, log }) {
  const OWNER = process.env.OWNER_NAME || 'Andy';
  const adresse = process.env.ADRESSE_MAISON || '';
  const outils = [
    {
      declaration: {
        type: 'function',
        name: 'alarme',
        description: 'Declenche ou arrete la sirene du robot, dans la maison.',
        parameters: {
          type: 'object',
          properties: { on: { type: 'boolean', description: 'true pour declencher, false pour arreter' } },
          required: ['on'],
        },
      },
      executer: async ({ on }) => {
        io.to(code).emit('robot_alarme', { on: !!on });
        log(`[TEL] ${code} : sirene ${on ? 'declenchee' : 'arretee'} par l'assistant.`);
        return [{ type: 'text', text: on ? 'Sirene declenchee.' : 'Sirene arretee.' }];
      },
    },
    {
      declaration: {
        type: 'function',
        name: 'dire_par_le_robot',
        description:
          "Fait dire une phrase par le haut-parleur du robot, DANS la maison (par exemple a l'intrus). " +
          "Ce que dit l'utilisateur au telephone n'y est PAS diffuse sans cet outil.",
        parameters: {
          type: 'object',
          properties: { texte: { type: 'string', description: 'La phrase exacte a prononcer' } },
          required: ['texte'],
        },
      },
      executer: async ({ texte }) => {
        const t = String(texte || '').trim().slice(0, 300);
        if (!t) return [{ type: 'text', text: 'Rien a dire.' }];
        io.to(code).emit('robot_say', { text: t });
        log(`[TEL] ${code} : le robot dit "${t}"`);
        return [{ type: 'text', text: 'Phrase prononcee par le robot.' }];
      },
    },
  ];

  const numeroProche = process.env.PROCHE_NUMERO;
  if (numeroProche) {
    const nom = process.env.PROCHE_NOM || 'le proche enregistre';
    let dejaPrevenu = false;
    outils.push({
      declaration: {
        type: 'function',
        name: 'prevenir_proche',
        description:
          `Appelle ${nom} et lui lit un message d'alerte avec l'adresse. ` +
          `A utiliser seulement si ${OWNER} le demande ou l'accepte.`,
        parameters: {
          type: 'object',
          properties: { message: { type: 'string', description: 'Ce qui se passe, en une phrase' } },
          required: ['message'],
        },
      },
      executer: async ({ message }) => {
        // Un seul appel par conversation : le modele qui se repete ne doit
        // pas harceler le voisin.
        if (dejaPrevenu) return [{ type: 'text', text: `${nom} a deja ete appele pendant cet appel.` }];
        dejaPrevenu = true;
        const texte =
          `Message automatique du robot de surveillance de ${OWNER}. ` +
          `Une personne a été vue chez lui${adresse ? `, au ${adresse}` : ''}. ` +
          `${String(message || '').slice(0, 300)} ` +
          `${OWNER} vous demande de vérifier, et d'appeler le 17 si nécessaire.`;
        const twiml =
          '<Response>' +
          `<Say language="fr-FR" voice="Polly.Lea">${xml(texte)}</Say>` +
          '<Pause length="1"/>' +
          `<Say language="fr-FR" voice="Polly.Lea">${xml(texte)}</Say>` +
          '</Response>';
        const r = await require('./appel-alerte').lancerAppelTwilio({ to: numeroProche, twiml, log });
        if (!r.ok) {
          dejaPrevenu = false;
          return [{ type: 'text', text: `L'appel a ${nom} a echoue.` }];
        }
        log(`[TEL] ${code} : ${nom} prevenu (${r.sid || '?'}).`);
        return [{ type: 'text', text: `${nom} est en train d'etre appele.` }];
      },
    });
  }
  return outils;
}

function consignesTelephone({ heure, phrase }) {
  const OWNER = process.env.OWNER_NAME || 'Andy';
  const adresse = process.env.ADRESSE_MAISON || '';
  const nomProche = process.env.PROCHE_NUMERO ? process.env.PROCHE_NOM || 'son proche' : null;
  return (
    `APPEL TELEPHONIQUE. Tu parles a ${OWNER} AU TELEPHONE : c'est toi qui l'as appele, ` +
    `parce qu'une personne a ete vue chez lui pendant son absence, a ${heure}` +
    (phrase ? ` (sur la photo : ${phrase})` : '') +
    `. Tu ne parles PAS a quelqu'un dans la maison, et ce que dit ${OWNER} n'y est pas diffuse. ` +
    `Pour parler a la personne dans la maison, utilise dire_par_le_robot. Pour la sirene, alarme. ` +
    `L'outil regarder montre la DERNIERE PHOTO D'ALERTE, pas forcement l'instant present : dis-le.\n\n` +
    `SECOURS. Tu ne peux PAS appeler la police, les pompiers, le 17 ou le 112, et tu ne dois ` +
    `jamais pretendre l'avoir fait ni qu'ils arrivent. Si ${OWNER} demande les secours, ou si la ` +
    `situation semble dangereuse, dis-lui clairement de raccrocher et d'appeler lui-meme le 17 ` +
    `(police) ou le 112, et donne-lui en une phrase quoi leur dire : ` +
    (adresse ? `l'adresse, ${adresse}, ` : "l'adresse de la maison, ") +
    `et la description de la personne.` +
    (nomProche ? ` Tu peux aussi prevenir ${nomProche} avec prevenir_proche, si ${OWNER} le demande ou l'accepte.` : '') +
    `\n\nN'agis pas seul sur ce qui est grave : sirene, message a l'intrus et appel d'un proche ` +
    `se font a la demande de ${OWNER}, ou apres lui avoir propose. Reste calme et bref : il est ` +
    `peut-etre inquiet, dans la rue, ou au travail.`
  );
}

function imageAlerte(code) {
  try {
    return fs.readFileSync(`${DOSSIER_ALERTES}/${code}.jpg`);
  } catch {
    return null;
  }
}

function attachAppelDirect(server, io, log = console.log) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let chemin = '';
    try { chemin = new URL(req.url, 'http://x').pathname; } catch {}
    // Les autres demandes (socket.io, /robot-audio) ne nous regardent pas.
    if (chemin !== CHEMIN_FLUX) return;
    wss.handleUpgrade(req, socket, head, (ws) => brancher(ws));
  });

  function brancher(ws) {
    let session = null;
    let streamSid = null;
    let code = '?';
    let finForcee = null;

    const versTwilio = (objet) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(objet));
    };
    const terminer = (raison) => {
      clearTimeout(finForcee);
      finForcee = null;
      if (session) {
        const s = session;
        session = null;
        log(`[TEL] ${code} : fin de l'appel (${raison}).`);
        s.fermer();
      }
      // Fermer le flux termine le <Connect>, donc l'appel : on raccroche.
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    ws.on('message', (brut) => {
      let m;
      try { m = JSON.parse(brut.toString()); } catch { return; }

      if (m.event === 'start') {
        streamSid = m.start && m.start.streamSid;
        const jeton = m.start && m.start.customParameters && m.start.customParameters.jeton;
        const a = jeton && attentes.get(jeton);
        if (jeton) attentes.delete(jeton);
        if (!a || a.expire < Date.now()) {
          log('[TEL] flux refuse : jeton absent, inconnu ou expire.');
          ws.close();
          return;
        }
        code = a.code;
        log(`[TEL] ${code} : appel decroche, conversation avec l'assistant.`);
        session = new SessionVocale({
          code,
          io,
          log,
          veille: false,
          annoncer: false,
          etiquette: 'TEL',
          formatAudio: { type: 'audio/pcmu' },
          // Le telephone est bien plus calme que le micro du robot : un seuil
          // plus bas, sinon les mots prononces doucement passent a la trappe.
          detection: {
            type: 'server_vad',
            threshold: Number(process.env.APPEL_VAD_SEUIL || 0.5),
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
          },
          consignes: consignesTelephone(a),
          outils: outilsTelephone({ io, code, log }),
          image: () => imageAlerte(code),
          accueil:
            "[L'appel vient d'etre decroche.] Annonce en une ou deux phrases pourquoi tu appelles " +
            "et ce que montre la photo, puis demande ce qu'il veut faire.",
          onAudio: (octets) => {
            versTwilio({ event: 'media', streamSid, media: { payload: Buffer.from(octets).toString('base64') } });
          },
          onEtat: (e) => {
            // On lui coupe la parole : Twilio doit jeter l'audio deja recu
            // mais pas encore joue, sinon il finit sa phrase par-dessus.
            if (e.interrompre) versTwilio({ event: 'clear', streamSid });
            if (e.actif === false) terminer('session OpenAI fermee');
          },
        });
        if (!session.ouvrir()) {
          terminer('OpenAI indisponible');
          return;
        }
        finForcee = setTimeout(() => terminer('duree maximale atteinte'), DUREE_MAX_MS());
        return;
      }

      if (m.event === 'media' && session && m.media && m.media.payload) {
        session.pousserAudio(Buffer.from(m.media.payload, 'base64'));
        return;
      }

      if (m.event === 'stop') terminer('raccroche');
    });

    ws.on('close', () => terminer('flux ferme'));
    ws.on('error', (e) => {
      log(`[TEL] ${code} : erreur du flux : ${e.message}`);
      terminer('erreur du flux');
    });
  }

  log(`[TEL] conversation telephonique prete (${urlFlux()}).`);
}

module.exports = { attachAppelDirect, twimlConversation };
