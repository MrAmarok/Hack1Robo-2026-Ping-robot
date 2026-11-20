// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Expo } = require('expo-server-sdk');

const app = express();
const server = http.createServer(app);
const expo = new Expo();
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Tolerance reseau mobile (4G): on attend plus longtemps un "pong" avant de
  // declarer la coupure, sinon une micro-coupure 4G (>20s par defaut) deconnecte
  // le robot en boucle. 60s de marge = session qui survit aux trous de reseau.
  pingInterval: 25000,
  pingTimeout: 60000,
  // Clips vocaux du talkie-walkie (base64) : la limite par defaut (1 Mo)
  // est trop juste, on monte a 3 Mo.
  maxHttpBufferSize: 3 * 1024 * 1024,
});

// Identifiants de publication MediaMTX (talkie en direct). Mot de passe genere
// a l'installation et garde sur le VPS : il ne transite jamais par l'app.
const MTX_USER = process.env.MTX_USER || 'robot';
const MTX_PASS = (() => {
  if (process.env.MTX_PASS) return process.env.MTX_PASS;
  try {
    return require('fs').readFileSync('/opt/mediamtx/publish-pass.txt', 'utf8').trim();
  } catch {
    return '';
  }
})();

app.use(cors());

// --- Proxy WHEP (video WebRTC du robot) ---
// Le firewall du fournisseur VPS ne laisse passer que quelques ports TCP
// (22/80/443/3000/3001/3002/8080, et AUCUN UDP entrant). MediaMTX ecoute donc :
//   - RTSP :3002 (le robot y publie son H.264)  [attention: 3002 = ancien
//     DEFAULT_PORT de ce serveur ; en prod ce serveur tourne avec PORT=3000]
//   - media WebRTC en ICE-TCP :8080 (le telephone s'y connecte)
//   - HTTP WHEP 127.0.0.1:8889, accessible uniquement via CE proxy :
//     l'app appelle http://<vps>:3000/rtc/robot-<CODE>/whep
// Monte AVANT express.json() pour laisser passer les corps application/sdp.
app.use('/rtc', (req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: 8889,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8889' },
    },
    (up) => {
      const headers = { ...up.headers };
      // L'URL de la ressource WHEP renvoyee par MediaMTX doit rester derriere /rtc.
      if (headers.location && !/^https?:/i.test(headers.location)) {
        headers.location = '/rtc' + headers.location;
      }
      res.writeHead(up.statusCode, headers);
      up.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'mediamtx injoignable' });
    else res.end();
  });
  req.pipe(upstream);
});

app.use(express.json());

// --- Assistant vocal du robot ("Hey Solana") ---
// Le robot envoie l'audio capte apres le mot-cle ; le VPS transcrit, demande a
// Claude quoi repondre/faire, execute les outils (pilotage, navigation, vision)
// et renvoie le texte que le robot prononce. Sans ANTHROPIC_API_KEY : inactif.
try {
  require('./voice-brain').attachVoiceBrain(io, console.log);
  // Conversation vocale en direct (Realtime OpenAI). S'annonce inactive
  // toute seule si OPENAI_API_KEY est absente : le tour par tour continue
  // de fonctionner sans elle.
  require('./realtime-voix').attachRealtimeVoix(io, console.log);
} catch (e) {
  console.log('[VOICE] assistant vocal non demarre :', e.message);
}

// --- Appel d'alerte en conversation ---
// Quand on decroche, l'appel est branche sur l'assistant (meme session que
// la conversation du robot). Sans lui, l'appel retombe sur le message lu.
try {
  require('./appel-direct').attachAppelDirect(server, io, console.log);
} catch (e) {
  console.log('[TEL] conversation telephonique non demarree :', e.message);
}

// --- Enregistrement de la vue camera ---
// Recopie le flux deja publie par le robot dans un fichier mp4, sans le
// reencoder : des rushes en vue robot, sans l'interface de l'app par-dessus.
try {
  require('./enregistrement').attachEnregistrement(io, console.log, refuseSiPasPilote);
} catch (e) {
  console.log('[REC] enregistrement non demarre :', e.message);
}

// ---- États mémoire ----
const users = new Map();            // socketId -> { pseudo, code }
const pushTokens = new Map();       // socketId -> expoPushToken (volatile)
const DEFAULT_PORT = 3002;
let PORT = Number(process.env.PORT || DEFAULT_PORT);
// Adresse publique du serveur, utilisee dans les liens envoyes par Telegram.
// HTTPS obligatoire : iOS refuse d'afficher une image de notification servie
// en clair (ATS). nginx relaie /ouvrir et /alerte-photo vers ce serveur.
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://api.ping-app.org';
const ROBOT_DEBUG_LOGS = String(process.env.ROBOT_DEBUG_LOGS || '').toLowerCase() === 'true';
const robotLog = (...args) => {
  if (ROBOT_DEBUG_LOGS) console.log(...args);
};
// Commande moteur valide : F/B/L/R/S/+/-, V<n> (vitesse absolue, ex "V180")
// ou M<gauche>,<droite> (pilotage differentiel, ex "M100,-40").
//
// Le format M manquait a cette liste alors que le robot sait le traiter depuis
// l'ajout du joystick proportionnel. Consequence : le serveur jetait TOUS les
// ordres de virage avant qu'ils n'atteignent le robot. Comme le plein ecran
// n'a que les boutons avancer et reculer, le joystick etait le seul moyen de
// tourner — le robot ne tournait donc plus du tout. Constate le 28/09/2026.
const isDriveCmd = (c) =>
  ('FBLRS+-'.includes(c) && c.length === 1) ||
  /^V\d{2,3}$/.test(c) ||
  /^M-?\d{1,3},-?\d{1,3}$/.test(c);

// Nouveaux états pour “connexion persistante”
const socketToUserId = new Map();   // socketId -> userId
const profiles = new Map();         // userId -> { pseudo, code, lastSeen, online, offlineTimer? }
const queues = new Map();           // userId -> [{ type, payload }]
const GRACE_MS = 5 * 60 * 1000;     // 5 minutes de tolérance

// ========================
// Qui a le droit de commander
// ========================
//
// Jusqu'ici, toute personne connectee au salon pouvait piloter le robot,
// declencher l'alarme ou changer le mode. A plusieurs, deux ordres
// contradictoires pouvaient partir en meme temps vers une machine qui roule.
//
// Desormais : le PREMIER arrive pilote, les suivants ne voient que la camera,
// et personne n'entre sans l'accord du pilote.
//
// Le robot lui-meme se connecte comme un utilisateur ordinaire : il est
// explicitement ecarte de cette election, sans quoi il deviendrait pilote de
// son propre salon et plus personne ne pourrait rien commander.
const pilotes = new Map();      // code -> socketId du pilote
const spectateurs = new Map();  // code -> Set<socketId>
const enAttente = new Map();    // code -> Map<socketId, { pseudo, ts }>
const robots = new Set();       // socketIds reconnus comme robots

function groupeSpectateurs(code) {
  if (!spectateurs.has(code)) spectateurs.set(code, new Set());
  return spectateurs.get(code);
}

function fileAttente(code) {
  if (!enAttente.has(code)) enAttente.set(code, new Map());
  return enAttente.get(code);
}

// Le pilote est-il toujours la ? Un socket ferme laisse une entree morte, et
// sans ce controle plus personne ne pourrait jamais reprendre la main.
function pilotePresent(code) {
  const id = pilotes.get(code);
  if (!id) return false;
  if (io.sockets.sockets.has(id)) return true;
  pilotes.delete(code);
  return false;
}

function estPilote(socket) {
  const info = users.get(socket.id);
  return !!info && pilotes.get(info.code) === socket.id;
}

// Promeut un spectateur quand le pilote s'en va. Sans ca, le depart du pilote
// condamnerait le salon a l'observation jusqu'au prochain redemarrage.
function reattribuerPilote(code) {
  const grp = groupeSpectateurs(code);
  for (const id of grp) {
    if (!io.sockets.sockets.has(id)) { grp.delete(id); continue; }
    grp.delete(id);
    pilotes.set(code, id);
    io.to(id).emit('role_acces', { role: 'pilote', raison: 'le pilote precedent est parti' });
    io.to(code).emit('pilote_change', { pseudo: (users.get(id) || {}).pseudo || null });
    console.log(`[ROLE] ${code} : ${(users.get(id) || {}).pseudo || id} devient pilote.`);
    return true;
  }
  pilotes.delete(code);
  console.log(`[ROLE] ${code} : plus de pilote, le prochain arrivant prendra la main.`);
  return false;
}

// Refuse une commande venant d'un non-pilote. Renvoie true si on doit arreter.
// Filet de securite : un client qui envoie un etat de robot EST un robot.
//
// Le marqueur envoye a l'appairage ne suffit pas : un robot qui tourne encore
// l'ancien code se connecterait sans lui et, s'il arrive le premier, prendrait
// la place de pilote de son propre salon. Plus personne ne pourrait alors lui
// donner un ordre. Ici on le reconnait a ce qu'il fait, et on lui retire la
// place s'il l'avait prise.
function marquerRobot(socket) {
  if (robots.has(socket.id)) return;
  robots.add(socket.id);
  const info = users.get(socket.id);
  if (!info) return;
  if (pilotes.get(info.code) === socket.id) {
    pilotes.delete(info.code);
    console.log(`[ROLE] ${info.code} : le robot avait pris la place de pilote, elle est rendue.`);
    reattribuerPilote(info.code);
  }
  groupeSpectateurs(info.code).delete(socket.id);
}

function refuseSiPasPilote(socket, nom) {
  if (robots.has(socket.id)) return false;      // le robot n'est pas un client
  if (estPilote(socket)) return false;
  const info = users.get(socket.id) || {};
  console.log(`[ROLE] commande "${nom}" refusee a ${info.pseudo || socket.id} : spectateur.`);
  socket.emit('acces_refuse_commande', { commande: nom });
  return true;
}

// --- Journal par room pour rattraper les messages manqués ---
const roomMessages = new Map(); // code -> [{ ts, type, payload }]
const ROOM_LOG_LIMIT = 500;

// --- Salon 24h ---
const LOBBY_DURATION_MS = 24 * 60 * 60 * 1000; // 24h
const lobbies = new Map();   // code -> { startedAt, expiresAt, hosts:Set<pseudo>, members:Set<pseudo> }
const lobbyTimers = new Map(); // code -> timeout

// --- Alertes par Telegram ---
//
// Pourquoi Telegram plutot que la notification de l'app : les push iOS
// dependent d'une cle APNs, elle-meme liee a un abonnement Apple payant. Le
// jour ou il expire, Apple refuse tout (InvalidProviderToken) et l'alerte
// disparait en silence — precisement ce qui est arrive le 24/09/2026.
// Telegram ne depend ni d'Apple ni de Google, ne coute rien, n'expire pas,
// et pourra porter la photo de ce que le robot a vu.
//
// Les secrets vivent dans /root/server/.env (charge par voice-brain.js), et
// sont lus A CHAQUE APPEL : le .env est lu apres le demarrage de ce module,
// une constante figee ici serait vide.
async function envoyerTelegram(texte) {
  const jeton = process.env.TELEGRAM_TOKEN;
  const salon = process.env.TELEGRAM_CHAT_ID;
  if (!jeton || !salon) {
    console.log('[TELEGRAM] non configure (TELEGRAM_TOKEN / TELEGRAM_CHAT_ID absents du .env).');
    return false;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://api.telegram.org/bot${jeton}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: salon, text: texte }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
      console.log(`[TELEGRAM] refus (HTTP ${r.status}) : ${j.description || 'sans detail'}`);
      return false;
    }
    console.log('[TELEGRAM] alerte envoyee.');
    return true;
  } catch (e) {
    console.log('[TELEGRAM] envoi impossible :', e.message);
    return false;
  }
}

// --- Tokens persistants (clé: code -> pseudo -> Set(token)) ---
//
// "Persistants" ne l'etait que de nom : cette table vivait uniquement en
// memoire. A CHAQUE redemarrage du serveur, tous les jetons disparaissaient
// et plus personne ne recevait de notification tant que son app n'avait pas
// ete rouverte. Pour une fonction de surveillance c'est inacceptable : on se
// croit protege alors que les alertes ne partent nulle part.
// Elle est donc maintenant ecrite sur le disque et relue au demarrage.
const PUSH_FICHIER = require('path').join(__dirname, 'push-tokens.json');
const persistentPushTokens = new Map(); // Map<string, Map<string, Set<string>>>

function sauverTokens() {
  try {
    const plat = {};
    for (const [code, byPseudo] of persistentPushTokens.entries()) {
      plat[code] = {};
      for (const [pseudo, set] of byPseudo.entries()) plat[code][pseudo] = [...set];
    }
    require('fs').writeFileSync(PUSH_FICHIER, JSON.stringify(plat));
  } catch (e) {
    console.log('[PUSH] enregistrement des jetons impossible :', e.message);
  }
}

function chargerTokens() {
  try {
    const plat = JSON.parse(require('fs').readFileSync(PUSH_FICHIER, 'utf8'));
    let n = 0;
    for (const [code, byPseudo] of Object.entries(plat)) {
      const m = new Map();
      for (const [pseudo, arr] of Object.entries(byPseudo)) {
        m.set(pseudo, new Set(arr));
        n += arr.length;
      }
      persistentPushTokens.set(code, m);
    }
    console.log(`[PUSH] ${n} jeton(s) restaure(s) depuis le disque.`);
  } catch {
    console.log('[PUSH] aucun jeton enregistre (premier demarrage ?).');
  }
}
chargerTokens();

function addPersistentToken(code, pseudo, token) {
  if (!code || !pseudo || !token) return;
  if (!persistentPushTokens.has(code)) persistentPushTokens.set(code, new Map());
  const byPseudo = persistentPushTokens.get(code);
  if (!byPseudo.has(pseudo)) byPseudo.set(pseudo, new Set());
  const avant = byPseudo.get(pseudo).size;
  byPseudo.get(pseudo).add(token);
  if (byPseudo.get(pseudo).size !== avant) sauverTokens();
}
// Jeton refuse par Google/Apple (DeviceNotRegistered) : app desinstallee, ou
// jeton remplace par le systeme. Le garder ferait echouer chaque alerte en
// silence pour cet appareil — on le retire partout.
function retirerJetonMort(token) {
  let retire = false;
  for (const byPseudo of persistentPushTokens.values()) {
    for (const set of byPseudo.values()) if (set.delete(token)) retire = true;
  }
  for (const [sid, t] of pushTokens.entries()) {
    if (t === token) { pushTokens.delete(sid); retire = true; }
  }
  if (retire) {
    sauverTokens();
    console.log(`[PUSH] jeton mort retire : ${String(token).slice(-9)}`);
  }
}

function getTokensForRoom(code) {
  const out = [];
  const byPseudo = persistentPushTokens.get(code);
  if (!byPseudo) return out;
  for (const set of byPseudo.values()) for (const t of set) out.push(t);
  return out;
}
function getTokensForPseudos(code, pseudos) {
  const out = [];
  const byPseudo = persistentPushTokens.get(code);
  if (!byPseudo) return out;
  for (const p of pseudos) {
    const set = byPseudo.get(p);
    if (set) for (const t of set) out.push(t);
  }
  return out;
}

function logRoomEvent(code, type, payload) {
  if (!code) return;
  if (!roomMessages.has(code)) roomMessages.set(code, []);
  const arr = roomMessages.get(code);
  arr.push({ ts: Date.now(), type, payload });
  if (arr.length > ROOM_LOG_LIMIT) arr.splice(0, arr.length - ROOM_LOG_LIMIT);
}
function getEventsSince(code, sinceTs) {
  const arr = roomMessages.get(code) || [];
  if (!sinceTs) return arr;
  return arr.filter(e => e.ts > sinceTs);
}

// helpers présence
const userIdOf = (code, pseudo) => `${code}::${pseudo}`;
function ensureProfile(code, pseudo) {
  const id = userIdOf(code, pseudo);
  let p = profiles.get(id);
  if (!p) {
    p = { pseudo, code, lastSeen: Date.now(), online: false, offlineTimer: null };
    profiles.set(id, p);
  }
  return { id, profile: p };
}
function enqueueFor(userId, item) {
  if (!queues.has(userId)) queues.set(userId, []);
  queues.get(userId).push(item);
}
function deliverQueueTo(userId, socketIdsInRoom) {
  const q = queues.get(userId);
  if (!q || q.length === 0) return;
  const targetSocketId = socketIdsInRoom[0];
  if (!targetSocketId) return;
  for (const item of q) {
    if (item.type === 'buzz') {
      io.to(targetSocketId).emit('buzz', item.payload);
    } else if (item.type === 'meet_request') {
      io.to(targetSocketId).emit('meet_request', item.payload);
    } else if (item.type === 'meet_accepted') {
      io.to(targetSocketId).emit('meet_accepted', item.payload);
    } else if (item.type === 'meet_declined') {
      io.to(targetSocketId).emit('meet_declined', item.payload);
    } else if (item.type === 'meet_canceled') {
      io.to(targetSocketId).emit('meet_canceled', item.payload);
    } else if (item.type === 'peer_location') {
      io.to(targetSocketId).emit('peer_location', item.payload);
    } else if (item.type === 'lobby_state') {
      io.to(targetSocketId).emit('lobby_state', item.payload);
    }
  }
  queues.set(userId, []); // purge
}
function markOnline(userId) {
  const p = profiles.get(userId);
  if (!p) return;
  p.lastSeen = Date.now();
  p.online = true;
  if (p.offlineTimer) {
    clearTimeout(p.offlineTimer);
    p.offlineTimer = null;
  }
}
function planMarkOffline(userId) {
  const p = profiles.get(userId);
  if (!p) return;
  if (p.offlineTimer) clearTimeout(p.offlineTimer);
  p.offlineTimer = setTimeout(() => {
    const now = Date.now();
    if (now - p.lastSeen >= GRACE_MS) {
      p.online = false;
      io.to(p.code).emit('user_left');
    }
  }, GRACE_MS);
}

// --- Helpers Push (incluent tokens persistants) ---
async function sendSilentSyncPushToRoom(roomCode, excludeSocketId) {
  const notifications = [];
  const seen = new Set();

  // sockets connectés
  for (const [socketId, userInfo] of users.entries()) {
    if (userInfo.code === roomCode && socketId !== excludeSocketId) {
      const token = pushTokens.get(socketId);
      if (token && Expo.isExpoPushToken(token) && !seen.has(token)) {
        notifications.push({
          to: token, contentAvailable: true, priority: 'high', data: { type: 'sync' }
        });
        seen.add(token);
      }
    }
  }
  // tokens persistants
  for (const token of getTokensForRoom(roomCode)) {
    if (Expo.isExpoPushToken(token) && !seen.has(token)) {
      notifications.push({
        to: token, contentAvailable: true, priority: 'high', data: { type: 'sync' }
      });
      seen.add(token);
    }
  }
  if (notifications.length > 0) await expo.sendPushNotificationsAsync(notifications);
}

// UN SEUL endroit ou le message est construit.
//
// Il l'etait auparavant a quatre endroits — pour chaque fonction d'envoi, une
// fois pour les destinataires connectes et une fois pour les jetons du disque
// — et ces copies avaient fini par diverger : seule celle des destinataires
// connectes portait interruptionLevel. Or c'est l'autre qui sert quand l'app
// est FERMEE (plus de socket, donc plus de destinataire connecte). Resultat :
// app ouverte, la notification s'affichait ; app fermee, iOS la rangeait dans
// son resume programme — livree, donc "confirmee" dans les logs, mais jamais
// vue. Exactement le cas ou une alerte d'intrusion doit passer.
// Constate le 25/09/2026.
// Toutes les traces du serveur sont horodatees.
//
// Sans heure, un log ne dit pas SI un evenement a eu lieu au bon moment — et
// c'est exactement la question restee sans reponse le 28/09 : la notification
// etait bien envoyee et confirmee par Apple, mais impossible de la rattacher a
// la detection qui aurait du la declencher.
{
  const brut = console.log;
  console.log = (...a) => brut(`[${new Date().toLocaleTimeString('fr-FR')}]`, ...a);
}

// ========================
// Budget de notification, par CATEGORIE
// ========================
//
// Le piege serait d'etouffer les alertes avec une seule minuterie globale :
// un chat qui la consomme rendrait le systeme muet pour la personne qui entre
// juste apres. Chaque categorie a donc son propre compteur.
//
// Une personne passe presque toujours ; un animal et un declenchement sans
// rien de visible se taisent longtemps, parce que ce sont eux qui lassent.
// Et ce filtrage ne porte QUE sur la notification : l'alerte, sa photo et son
// analyse sont enregistrees dans tous les cas, donc rien n'est jamais perdu.
const CADENCE_NOTIF = {
  personne: Number(process.env.CADENCE_PERSONNE || 30000),
  animal: Number(process.env.CADENCE_ANIMAL || 900000),
  rien: Number(process.env.CADENCE_RIEN || 900000),
};
const derniereNotif = new Map(); // code -> { personne, animal, rien }

function notifAutorisee(code, categorie) {
  const cat = CADENCE_NOTIF[categorie] ? categorie : 'rien';
  if (!derniereNotif.has(code)) derniereNotif.set(code, {});
  const par = derniereNotif.get(code);
  const t = Date.now();
  if (par[cat] && t - par[cat] < CADENCE_NOTIF[cat]) return false;
  par[cat] = t;
  return true;
}

// Les alertes recentes, gardees en entier pour pouvoir les relire.
const DOSSIER_ALERTES = '/root/server/alertes';
const ALERTES_GARDEES = Number(process.env.ALERTES_GARDEES || 60);
const historiqueAlertes = new Map(); // code -> [ {ts, type, categorie, phrase, photo, notifiee} ]
const FICHIER_ALERTES = '/root/server/alertes.json';

// L'historique survit aux redemarrages. Sans ca, la promesse "rien n'est
// perdu" serait fausse des le premier redeploiement du serveur — et c'est
// justement l'historique qui rattrape les notifications volontairement tues.
function sauverHistorique() {
  try {
    const plat = {};
    for (const [c, liste] of historiqueAlertes) plat[c] = liste;
    require('fs').writeFileSync(FICHIER_ALERTES, JSON.stringify(plat));
  } catch (e) {
    console.log('[ALERTE] historique non enregistre :', e.message);
  }
}

function chargerHistorique() {
  try {
    const plat = JSON.parse(require('fs').readFileSync(FICHIER_ALERTES, 'utf8'));
    let n = 0;
    for (const [c, liste] of Object.entries(plat)) {
      if (Array.isArray(liste)) { historiqueAlertes.set(c, liste); n += liste.length; }
    }
    if (n) console.log(`[ALERTE] ${n} alerte(s) relue(s) depuis le disque.`);
  } catch {
    // Premier demarrage : rien a relire, ce n'est pas une erreur.
  }
}
chargerHistorique();

function messagePush({ token, title, body, data = {}, sound = 'default', image = null }) {
  return {
    to: token,
    sound,
    title,
    body,
    data,
    // priority 'high' : reveille l'appareil au lieu de grouper l'envoi.
    priority: 'high',
    // Canal Android, nomme EXPLICITEMENT.
    //
    // L'app cree un canal 'default' en importance MAX (bannière, son, vibreur).
    // Sans ce champ, Android range la notification dans un canal par defaut
    // d'importance normale : visible quand l'app est ouverte, mais discrete ou
    // silencieuse quand elle est fermee — exactement le symptome observe.
    channelId: 'default',
    // interruptionLevel 'time-sensitive' : sans lui, iOS retient l'alerte dans
    // son resume programme ou en mode Concentration. Pour une alerte, arriver
    // deux heures plus tard revient a ne pas arriver.
    interruptionLevel: 'time-sensitive',
    ...(image ? { richContent: { image } } : {}),
  };
}

async function sendVisiblePushToRoom({ roomCode, excludeSocketId, title, body, data = {}, sound = 'default', image = null }) {
  const notifications = [];
  const seen = new Set();

  const message = (token) => messagePush({ token, title, body, data, sound, image });

  // sockets connectés
  for (const [socketId, userInfo] of users.entries()) {
    if (userInfo.code === roomCode && socketId !== excludeSocketId) {
      const token = pushTokens.get(socketId);
      if (token && Expo.isExpoPushToken(token) && !seen.has(token)) {
        notifications.push(message(token));
        seen.add(token);
      }
    }
  }
  // Jetons du disque : le chemin des appareils dont l'app est FERMEE.
  for (const token of getTokensForRoom(roomCode)) {
    if (Expo.isExpoPushToken(token) && !seen.has(token)) {
      notifications.push(message(token));
      seen.add(token);
    }
  }
  // Trace indispensable : sans elle, une notification qui ne part pas et une
  // notification refusee par Expo sont rigoureusement indiscernables — c'est
  // ce qui a coute la soiree du 24/09.
  if (notifications.length === 0) {
    console.log(`[PUSH] AUCUN destinataire pour le salon ${roomCode} — "${title}" non envoyee.`);
    return;
  }
  const tickets = await expo.sendPushNotificationsAsync(notifications);
  for (const t of tickets) {
    if (t.status === 'error') {
      console.log(`[PUSH] refus d'Expo : ${t.message} ${JSON.stringify(t.details || {})}`);
    }
  }
  // Le nombre seul ne sert a rien : deux jetons differents donnent tous les
  // deux "1 destinataire". On trace la FIN de chaque jeton vise, de quoi
  // reperer un jeton perime sans jamais ecrire le jeton en entier.
  const vises = notifications.map((n) => String(n.to).slice(-9)).join(', ');
  console.log(`[PUSH] "${title}" envoye a ${notifications.length} destinataire(s) : ${vises}`);

  // Expo repond en DEUX temps : le ticket ci-dessus dit seulement "accepte
  // pour traitement". Le vrai resultat de livraison arrive dans un RECU, a
  // aller chercher quelques secondes plus tard. C'est la — et nulle part
  // ailleurs — qu'apparaissent les erreurs qui comptent vraiment :
  // DeviceNotRegistered, MessageRateExceeded, et surtout InvalidCredentials
  // quand la cle push Apple manque au projet.
  // Les tickets reviennent dans l'ordre des envois : c'est ce qui permet de
  // savoir QUEL jeton un recu concerne.
  const jetonDuTicket = new Map();
  tickets.forEach((t, i) => {
    if (t.status === 'ok' && t.id) jetonDuTicket.set(t.id, notifications[i] && notifications[i].to);
  });
  const ids = [...jetonDuTicket.keys()];
  if (ids.length) {
    setTimeout(async () => {
      try {
        const recus = await expo.getPushNotificationReceiptsAsync(ids);
        for (const [id, r] of Object.entries(recus)) {
          const jeton = jetonDuTicket.get(id);
          const fin = String(jeton || '?').slice(-9);
          if (r.status === 'error') {
            console.log(`[PUSH] LIVRAISON ECHOUEE ${fin} : ${r.message} ${JSON.stringify(r.details || {})}`);
            if (r.details && r.details.error === 'DeviceNotRegistered' && jeton) retirerJetonMort(jeton);
          } else {
            console.log(`[PUSH] livraison confirmee ${fin}`);
          }
        }
      } catch (e) {
        console.log('[PUSH] recus illisibles :', e.message);
      }
    }, 7000);
  }
}

async function sendVisiblePushToPseudos({ roomCode, pseudos, title, body, data = {}, sound = 'default', image = null }) {
  const notifications = [];
  const seen = new Set();
  const set = new Set(pseudos);

  // sockets connectés ciblés
  for (const [socketId, userInfo] of users.entries()) {
    if (userInfo.code === roomCode && set.has(userInfo.pseudo)) {
      const token = pushTokens.get(socketId);
      if (token && Expo.isExpoPushToken(token) && !seen.has(token)) {
        notifications.push(messagePush({ token, title, body, data, sound, image }));
        seen.add(token);
      }
    }
  }
  // Jetons du disque : le chemin des appareils dont l'app est FERMEE.
  for (const token of getTokensForPseudos(roomCode, pseudos)) {
    if (Expo.isExpoPushToken(token) && !seen.has(token)) {
      notifications.push(messagePush({ token, title, body, data, sound, image }));
      seen.add(token);
    }
  }
  if (notifications.length === 0) {
    console.log(`[PUSH] AUCUN destinataire pour le salon ${roomCode} — notification non envoyee.`);
    return;
  }
  const tickets = await expo.sendPushNotificationsAsync(notifications);
  for (const t of tickets) {
    if (t.status === 'error') {
      console.log(`[PUSH] refus d'Expo : ${t.message} ${JSON.stringify(t.details || {})}`);
    }
  }
  console.log(`[PUSH] "${title}" envoye a ${notifications.length} destinataire(s).`);
}

// ========== LOBBY (Salon 24h) helpers ==========
function ensureLobby(code) {
  let lobby = lobbies.get(code);
  if (!lobby) {
    lobby = { startedAt: 0, expiresAt: 0, hosts: new Set(), members: new Set() };
    lobbies.set(code, lobby);
  }
  return lobby;
}
function startLobbyIfNeeded(code, hostPseudo) {
  const lobby = ensureLobby(code);
  const now = Date.now();
  if (!lobby.startedAt || lobby.expiresAt <= now) {
    lobby.startedAt = now;
    lobby.expiresAt = now + LOBBY_DURATION_MS;
    if (lobbyTimers.has(code)) clearTimeout(lobbyTimers.get(code));
    const t = setTimeout(() => expireLobby(code), lobby.expiresAt - Date.now());
    lobbyTimers.set(code, t);
  }
  if (hostPseudo) lobby.hosts.add(hostPseudo);
  return lobby;
}
function expireLobby(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  io.to(code).emit('lobby_expired', { code });
  logRoomEvent(code, 'lobby_expired', {});
  if (lobbyTimers.has(code)) {
    clearTimeout(lobbyTimers.get(code));
    lobbyTimers.delete(code);
  }
  lobbies.delete(code);
}
function lobbyStatePayload(code) {
  const lobby = lobbies.get(code);
  return {
    code,
    members: lobby ? [...lobby.members].map(p => ({ pseudo: p })) : [],
    expiresAt: lobby ? lobby.expiresAt : 0,
  };
}
async function broadcastLobbyState(code) {
  const payload = lobbyStatePayload(code);
  io.to(code).emit('lobby_state', payload);
  for (const pseudo of payload.members.map(m => m.pseudo)) {
    const uid = userIdOf(code, pseudo);
    enqueueFor(uid, { type: 'lobby_state', payload });
  }
}

// ========== SOCKET ==========
io.on('connection', (socket) => {
  console.log(`[CONNEXION] Utilisateur connecté : ${socket.id}`);

  // Pair + rattrapage immédiat si lastSeen fourni
  socket.on('pair', async ({ pseudo, code, lastSeen, robot }) => {
    if (!pseudo || !code) return;

    // Le robot ne participe pas a l'election : il entre directement.
    if (robot) robots.add(socket.id);

    if (!robots.has(socket.id)) {
      if (!pilotePresent(code)) {
        // Salon sans pilote : le premier arrive prend la main, sans demander.
        pilotes.set(code, socket.id);
        socket.emit('role_acces', { role: 'pilote' });
        console.log(`[ROLE] ${code} : '${pseudo}' est pilote.`);
      } else if (pilotes.get(code) !== socket.id) {
        // Quelqu'un d'autre pilote : on NE REJOINT PAS le salon tant que le
        // pilote n'a pas accepte. Sans ca, un inconnu verrait la camera de la
        // maison pendant qu'on lui demande s'il peut entrer.
        fileAttente(code).set(socket.id, { pseudo, ts: Date.now() });
        users.set(socket.id, { pseudo, code });
        socket.emit('role_acces', { role: 'attente' });
        io.to(pilotes.get(code)).emit('acces_demande', { id: socket.id, pseudo });
        console.log(`[ROLE] ${code} : '${pseudo}' demande a entrer, le pilote doit repondre.`);
        return;
      }
    }

    users.set(socket.id, { pseudo, code });
    socket.join(code);
    const { id } = ensureProfile(code, pseudo);
    socketToUserId.set(socket.id, id);
    markOnline(id);

    console.log(`[PAIR] '${pseudo}' a rejoint la room '${code}'`);
    socket.to(code).emit('user_joined', { pseudo });

    const socketsInRoom = await io.in(code).fetchSockets();
    socketsInRoom.forEach(skt => {
      if (skt.id !== socket.id) {
        const otherInfo = users.get(skt.id);
        if (otherInfo) socket.emit('user_joined', { pseudo: otherInfo.pseudo });
      }
    });

    const mySockets = socketsInRoom.filter(s => s.id === socket.id).map(s => s.id);
    deliverQueueTo(id, mySockets);

    if (typeof lastSeen === 'number') {
      const missed = getEventsSince(code, lastSeen);
      if (missed.length > 0) {
        socket.emit('sync_batch', { since: lastSeen || 0, items: missed });
      }
    }
  });

  // --- État "en train d'écrire" ---
  socket.on('start_typing', ({ code }) => {
    const room = code || (users.get(socket.id)?.code);
    if (!room) return;
    socket.to(room).emit('user_is_typing');
  });
  socket.on('stop_typing', ({ code }) => {
    const room = code || (users.get(socket.id)?.code);
    if (!room) return;
    socket.to(room).emit('user_stopped_typing');
  });

  // --- Sync manuelle
  socket.on('sync', ({ code, since }) => {
    try {
      const items = getEventsSince(code, since);
      socket.emit('sync_batch', { since: since || 0, items });
    } catch (e) {
      console.error('[SYNC] error', e);
    }
  });

  // --- Nudge ---
  socket.on('nudge', async ({ code, senderPseudo }) => {
    if (!code) return;
    console.log(`[NUDGE] Reçu de '${senderPseudo}' pour la room '${code}'.`);

    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && socketId !== socket.id) {
        io.to(socketId).emit('buzz', { message: `⚡ ${senderPseudo} t’a envoyé un rappel.` });
      }
    }
    logRoomEvent(code, 'buzz', { message: `⚡ ${senderPseudo} t’a envoyé un rappel.` });

    if (true) {
    await sendVisiblePushToRoom({
      roomCode: code,
      excludeSocketId: socket.id,
      title: 'Rappel ⚡',
      body: `${senderPseudo} t’a rappelé.`,
      data: { type: 'nudge' },
      // 'ringtone.mp3' n'existe pas dans le projet : ni fichier, ni ressource
      // embarquee. Le son du systeme, lui, sonne vraiment.
      sound: 'default'
    });
    await sendSilentSyncPushToRoom(code, socket.id);
    }

    socket.emit('buzz_sent_confirmation', { status: 'succès', text: 'Rappel envoyé.' });
  });

  // --- Buzz (message) ---
  socket.on('buzz', async ({ code, message }) => {
    const sender = users.get(socket.id);
    if (!sender || !code) return;
    const isRobotInternal = String(message || '').startsWith('PING_ROBOT_');
    if (isRobotInternal) {
      robotLog(`[BUZZ][ROBOT_INTERNAL] from=${sender.pseudo} code=${code} message=${message}`);
    }

    socket.to(code).emit('buzz', { message });
    if (isRobotInternal) {
      socket.emit('buzz_sent_confirmation', { status: 'succès', text: 'Message robot interne transmis.' });
      return;
    }
    logRoomEvent(code, 'buzz', { message });

    await sendVisiblePushToRoom({
      roomCode: code,
      excludeSocketId: socket.id,
      title: `⚡ Buzz de ${sender.pseudo}`,
      body: message,
      data: { type: 'buzz' }
    });
    await sendSilentSyncPushToRoom(code, socket.id);

    socket.emit('buzz_sent_confirmation', { status: 'succès', text: 'Buzz envoyé !' });
  });

  // --- Pilotage robot ---
  socket.on('robot_drive', ({ code, cmd, id }) => {
    if (refuseSiPasPilote(socket, 'robot_drive')) return;
    const sender = users.get(socket.id);
    const driveCmd = String(cmd || '').trim().toUpperCase();
    const cmdId = String(id || `${driveCmd}-${Date.now()}`);
    robotLog(`[ROBOT_DRIVE][IN] id=${cmdId} socket=${socket.id} sender=${sender?.pseudo || '?'} code=${code || '?'} cmd=${driveCmd}`);
    if (!sender || !code || !isDriveCmd(driveCmd)) {
      robotLog(`[ROBOT_DRIVE][DROP] id=${cmdId} sender=${!!sender} code=${!!code} cmd=${driveCmd}`);
      return;
    }

    const recipients = [...users.entries()].filter(
      ([socketId, userInfo]) => userInfo.code === code && socketId !== socket.id
    );
    robotLog(
      `[ROBOT_DRIVE][ROUTE] id=${cmdId} recipients=${recipients.length} -> ${
        recipients.map(([sid, u]) => `${u.pseudo}@${sid}`).join(',') || 'none'
      }`
    );
    if (recipients.length === 0) {
      socket.emit('robot_drive_status', {
        id: cmdId,
        cmd: driveCmd,
        ok: false,
        message: 'Aucun robot connecte avec ce code',
        by: 'serveur',
      });
      return;
    }

    socket.to(code).emit('robot_drive', { id: cmdId, cmd: driveCmd, by: sender.pseudo });
    logRoomEvent(code, 'robot_drive', { cmd: driveCmd, by: sender.pseudo });
    robotLog(`[ROBOT_DRIVE][EMIT] id=${cmdId} cmd=${driveCmd} by=${sender.pseudo}`);
    socket.emit('robot_drive_confirmation', { id: cmdId, ok: true, cmd: driveCmd });
  });

  socket.on('robot_drive_status', ({ code, cmd, ok, message, id }) => {
    const sender = users.get(socket.id);
    const driveCmd = String(cmd || '').trim().toUpperCase();
    const cmdId = String(id || `${driveCmd}-${Date.now()}`);
    robotLog(`[ROBOT_DRIVE_STATUS][IN] id=${cmdId} from=${sender?.pseudo || '?'} code=${code || '?'} cmd=${driveCmd} ok=${!!ok} msg=${message || ''}`);
    if (!code || !isDriveCmd(driveCmd)) {
      robotLog(`[ROBOT_DRIVE_STATUS][DROP] id=${cmdId} code=${!!code} cmd=${driveCmd}`);
      return;
    }

    io.to(code).emit('robot_drive_status', {
      id: cmdId,
      cmd: driveCmd,
      ok: !!ok,
      message: message || '',
      by: sender?.pseudo || 'Robot',
    });
  });

  socket.on('robot_status_request', ({ code }) => {
    const sender = users.get(socket.id);
    robotLog(`[ROBOT_STATUS_REQUEST][IN] socket=${socket.id} sender=${sender?.pseudo || '?'} code=${code || '?'}`);
    if (!sender || !code) return;
    const recipients = [...users.entries()].filter(
      ([socketId, userInfo]) => userInfo.code === code && socketId !== socket.id
    );
    if (recipients.length === 0) {
      robotLog(`[ROBOT_STATUS_REQUEST][NO_RECIPIENT] code=${code}`);
      socket.emit('robot_status', {
        fix: false,
        coords: null,
        arduinoConnected: false,
        by: 'serveur',
        error: 'Aucun robot connecte avec ce code',
        ts: Date.now(),
      });
      return;
    }
    robotLog(`[ROBOT_STATUS_REQUEST][EMIT] recipients=${recipients.length}`);
    socket.to(code).emit('robot_status_request', { by: sender.pseudo });
  });

  // --- Camera robot : relais des images et du on/off ---
  // Volontairement SANS logRoomEvent (un flux video saturerait la memoire).
  socket.on('robot_frame', ({ code, jpeg }, ack) => {
    // ACK immediat : le robot attend cet accuse pour envoyer l'image suivante
    // (envoi auto-regule = pas de file d'attente = pas de retard video).
    if (typeof ack === 'function') ack();
    if (!code || !jpeg) return;
    // volatile : si l'app est lente, on jette l'image au lieu de l'empiler
    // (les commandes robot, non-volatiles, gardent ainsi la priorite).
    socket.to(code).volatile.emit('robot_frame', { jpeg });
  });

  socket.on('robot_camera', ({ code, on }) => {
    if (!code) return;
    socket.to(code).emit('robot_camera', { on: !!on });
  });

  // Pan-tilt camera : angles servo absolus (app -> robot).
  socket.on('robot_cam_move', ({ code, pan, tilt, center, id, view }) => {
    if (refuseSiPasPilote(socket, 'robot_cam_move')) return;
    if (!code) return;
    const clamp = (v) =>
      Number.isFinite(Number(v)) ? Math.max(0, Math.min(180, Math.round(Number(v)))) : undefined;
    socket.to(code).emit('robot_cam_move', {
      pan: clamp(pan),
      tilt: clamp(tilt),
      center: !!center,
      // Bascule camera avant / arriere / double (2e webcam sur le robot)
      view: ['front', 'rear', 'both'].includes(view) ? view : undefined,
      id: String(id || `cam-${Date.now()}`),
    });
  });

  socket.on('robot_audio', ({ code, on }) => {
    if (!code) return;
    socket.to(code).emit('robot_audio', { on: !!on });
  });

  // L'app signale que sa video WebRTC est connectee : le robot bride alors ses
  // images socket (fallback/photo) a ~1 img/s pour ne pas doubler le debit 4G.
  socket.on('robot_rtc', ({ code, on }) => {
    if (!code) return;
    socket.to(code).emit('robot_rtc', { on: !!on });
  });

  // Negociation WHEP relayee par le socket : sur iPhone, ATS interdit les
  // requetes http:// depuis l'app (pas de certificat sur l'IP du VPS), alors
  // que ce websocket passe. On fait donc le POST vers MediaMTX ICI, en local.
  socket.on('rtc_offer', ({ code, sdp, kind }, ack) => {
    if (typeof ack !== 'function') return;
    if (!code || !sdp || typeof sdp !== 'string') return ack({ status: 400 });
    // kind 'audio' = le micro du robot, publie sur un chemin SEPARE (son
    // propre tuyau TCP, pour que l'audio ne subisse pas les rafales video).
    const path = kind === 'audio' ? `robot-${code}-audio` : `robot-${code}`;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8889,
        path: `/${path}/whep`,
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
      },
      (up) => {
        let body = '';
        up.on('data', (d) => (body += d));
        up.on('end', () =>
          ack({ status: up.statusCode, sdp: body, location: up.headers.location || null })
        );
      }
    );
    req.on('error', () => ack({ status: 502 }));
    req.end(sdp);
  });

  // Fin de session WHEP (le DELETE que l'app ne peut pas faire en http://).
  // --- Talkie-walkie EN DIRECT ---
  // L'app publie son micro en WebRTC (WHIP) vers MediaMTX sur le chemin
  // robot-<code>-talk ; le robot le lit en continu sur son enceinte. Fini le
  // "j'enregistre, j'envoie, il joue" : on parle, ca sort la-bas.
  // Le POST est fait ICI : iOS interdit les requetes http:// depuis l'app, et
  // MediaMTX n'ecoute qu'en local. Le mot de passe de publication ne quitte
  // donc jamais le serveur.
  // Parler DANS le robot : l'app publie sa voix vers MediaMTX, le robot la lit.
  //
  // Ce gestionnaire ne tracait RIEN — ni la tentative, ni la reponse de
  // MediaMTX, ni l'erreur reseau. Un echec y etait indiscernable d'une app qui
  // n'envoie rien du tout, et c'est precisement la question qu'on se pose quand
  // "parler ne marche plus".
  socket.on('rtc_publish_offer', ({ code, sdp }, ack) => {
    if (refuseSiPasPilote(socket, 'rtc_publish_offer')) return;
    if (typeof ack !== 'function') {
      console.log('[TALK] offre recue sans accuse de reception — ignoree.');
      return;
    }
    if (!code || !sdp || typeof sdp !== 'string') {
      console.log(`[TALK] offre invalide (code=${code || '-'}, sdp=${typeof sdp}).`);
      return ack({ status: 400 });
    }
    console.log(`[TALK] offre de publication pour ${code} (${sdp.length} octets de SDP).`);
    const auth = Buffer.from(`${MTX_USER}:${MTX_PASS}`).toString('base64');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: 8889,
        path: `/robot-${code}-talk/whip`,
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Authorization: `Basic ${auth}` },
      },
      (up) => {
        let body = '';
        up.on('data', (d) => (body += d));
        up.on('end', () => {
          if (up.statusCode >= 200 && up.statusCode < 300) {
            console.log(`[TALK] MediaMTX accepte la publication (${up.statusCode}).`);
          } else {
            console.log(`[TALK] MediaMTX REFUSE (${up.statusCode}) : ${body.slice(0, 200)}`);
          }
          ack({ status: up.statusCode, sdp: body, location: up.headers.location || null });
        });
      }
    );
    req.on('error', (e) => {
      console.log(`[TALK] MediaMTX injoignable : ${e.message}`);
      ack({ status: 502 });
    });
    req.end(sdp);
  });

  // L'app previent le robot qu'elle parle : il ouvre (ou ferme) son lecteur.
  socket.on('robot_talk_live', ({ code, on }) => {
    if (refuseSiPasPilote(socket, 'robot_talk_live')) return;
    console.log(`[TALK] lecture par le robot : ${on ? 'DEMARRER' : 'ARRETER'} (${code || '-'}).`);
    if (!code) return;
    socket.to(code).emit('robot_talk_live', { on: !!on });
  });

  socket.on('rtc_stop', ({ location }) => {
    if (typeof location !== 'string') return;
    // Uniquement une ressource WHEP de MediaMTX, rien d'autre.
    if (!/^\/robot-[A-Za-z0-9_-]+\/whep\/[A-Za-z0-9-]+$/.test(location)) return;
    const req = http.request({ host: '127.0.0.1', port: 8889, path: location, method: 'DELETE' });
    req.on('error', () => {});
    req.end();
  });

  // Bouton "parler" de l'app : reveille l'assistant vocal du robot sans avoir
  // a prononcer le mot-cle.
  socket.on('robot_listen', ({ code }) => {
    if (!code) return;
    socket.to(code).emit('robot_listen', {});
  });

  // L'app envoie un texte a faire dire au robot (haut-parleur Bluetooth).
  socket.on('robot_say', ({ code, text }) => {
    if (refuseSiPasPilote(socket, 'robot_say')) return;
    if (!code) return;
    socket.to(code).emit('robot_say', { text: String(text || '').slice(0, 300) });
  });

  // Talkie-walkie : clip vocal (base64) app -> robot, joue sur le haut-parleur.
  socket.on('robot_voice', ({ code, b64, ext }) => {
    if (refuseSiPasPilote(socket, 'robot_voice')) return;
    if (!code || !b64 || typeof b64 !== 'string') return;
    if (b64.length > 2 * 1024 * 1024) return; // ~1.5 Mo audio max
    socket.to(code).emit('robot_voice', {
      b64,
      ext: String(ext || 'm4a').replace(/[^a-z0-9]/gi, '').slice(0, 5),
    });
  });

  // --- Navigation auto : destination (app -> robot) et arrivee (robot -> app) ---
  socket.on('robot_nav', ({ code, target, on }) => {
    if (refuseSiPasPilote(socket, 'robot_nav')) return;
    if (!code) return;
    socket.to(code).emit('robot_nav', { target, on: !!on });
  });

  socket.on('robot_nav_status', ({ code, arrived, on }) => {
    if (!code) return;
    socket.to(code).emit('robot_nav_status', { arrived: !!arrived, on: !!on });
  });

  // --- Rondes de surveillance : commande (app -> robot) et etat (robot -> app) ---
  // Conversation temps reel : bascule demandee par l'app.
  socket.on('robot_rt', ({ code, on }) => {
    if (refuseSiPasPilote(socket, 'robot_rt')) return;
    if (!code) return;
    socket.to(code).emit('robot_rt', { on: !!on });
  });

  // Enregistrement HD filme par le robot lui-meme (a distinguer de
  // enregistrement.js, qui recopie le flux deja diffuse cote serveur).
  socket.on('robot_record_hd', ({ code, on }) => {
    if (refuseSiPasPilote(socket, 'robot_record_hd')) return;
    if (!code) return;
    socket.to(code).emit('robot_record_hd', { on: !!on });
  });

  socket.on('robot_record_hd_status', (p) => {
    if (!p || !p.code) return;
    socket.to(p.code).emit('robot_record_hd_status', p);
  });

  socket.on('robot_ronde', ({ code, action }) => {
    if (refuseSiPasPilote(socket, 'robot_ronde')) return;
    if (!code || !action) return;
    socket.to(code).emit('robot_ronde', { action: String(action) });
  });

  // Arret d'urgence : un seul bouton dans l'app doit tout figer.
  //
  // On ne se contente pas de relayer : une partie de ce qui fait rouler le
  // robot tourne ICI (suivi de personne, "va vers la poubelle"). On coupe
  // donc d'abord nos propres boucles, puis on previent le robot pour ce qu'il
  // pilote seul (navigation GPS, ronde, conversation en direct).
  socket.on('robot_stop_all', ({ code }) => {
    if (refuseSiPasPilote(socket, 'robot_stop_all')) return;
    if (!code) return;
    try {
      require('./voice-brain').toutArreter(io, code, console.log);
    } catch (e) {
      console.log('[STOP] voice-brain indisponible :', e.message);
    }
    socket.to(code).emit('robot_stop_all', {});
    // Redondance assumee : si le robot tourne encore une version qui ignore
    // 'robot_stop_all', ces quatre ordres-la, eux, il les connait deja.
    socket.to(code).emit('robot_drive', { id: `stopall-${Date.now()}`, cmd: 'S', by: 'arret-urgence' });
    socket.to(code).emit('robot_nav', { on: false });
    socket.to(code).emit('robot_ronde', { action: 'arreter' });
    socket.to(code).emit('robot_rt', { on: false });
    logRoomEvent(code, 'robot_stop_all', {});
  });

  // Enregistrement du jeton de notification PAR LA SOCKET.
  //
  // L'app le faisait par un POST HTTP sur /register-token — mais iOS bloque
  // les requetes en clair via sa securite de transport (ATS), alors qu'il
  // laisse passer les WebSocket. D'ou le symptome deroutant : la socket se
  // connectait parfaitement et le fetch echouait ("Network request failed")
  // vers la MEME adresse. On passe donc par le canal qui fonctionne.
  // Diagnostic envoye par l'app quand elle n'obtient PAS de jeton push.
  // Un echec cote telephone est invisible depuis ici : c'est ce canal qui le
  // rend lisible, au lieu de deviner installation apres installation.
  socket.on('app_diag', ({ code, pseudo, sujet, detail, plateforme, version }) => {
    console.log(
      `[DIAG] ${sujet || '?'} — ${plateforme || '?'} ${version || ''} ` +
      `(code=${code || '-'} pseudo=${pseudo || '-'}) : ${String(detail || '').slice(0, 300)}`
    );
  });

  // Le pilote accepte ou refuse une arrivee.
  socket.on('acces_reponse', ({ id, accepte }) => {
    const info = users.get(socket.id);
    if (!info || !estPilote(socket)) return;
    const code = info.code;
    const file = fileAttente(code);
    const dem = file.get(id);
    if (!dem) return;
    file.delete(id);

    const cible = io.sockets.sockets.get(id);
    if (!cible) return;

    if (accepte) {
      cible.join(code);
      groupeSpectateurs(code).add(id);
      cible.emit('role_acces', { role: 'spectateur' });
      io.to(code).emit('user_joined', { pseudo: dem.pseudo });
      console.log(`[ROLE] ${code} : '${dem.pseudo}' accepte comme spectateur.`);
    } else {
      cible.emit('acces_refuse', {});
      console.log(`[ROLE] ${code} : '${dem.pseudo}' refuse par le pilote.`);
    }
  });

  socket.on('register_token', ({ code, pseudo, token }) => {
    if (!token) return;
    pushTokens.set(socket.id, String(token));
    // Pseudo NETTOYE : un espace final a cree une seconde entree "Andy " avec
    // le meme jeton, et le compteur annoncait 3 appareils pour 2 reels. Une
    // comptabilite fausse rend tout diagnostic de notification trompeur.
    const p = String(pseudo || '').trim();
    if (code && p) addPersistentToken(String(code).trim(), p, String(token));
    console.log(
      // La FIN du jeton, jamais le jeton entier : assez pour distinguer deux
      // appareils, pas assez pour s'en servir. Sans elle, un iPhone qui se
      // reenregistre et un Android tout neuf produisent la meme ligne.
      `[PUSH] jeton recu par socket (…${String(token).slice(-9)} code=${code || '-'} pseudo=${pseudo || '-'} ` +
      `valide=${Expo.isExpoPushToken(String(token))} total_salon=${getTokensForRoom(String(code || '')).length})`
    );
    socket.emit('register_token_ok', { ok: true });
  });

  // Alerte de surveillance : le robot a entendu quelque chose en mode ABSENT.
  // On previent le telephone meme si l'app est fermee — c'est tout l'interet
  // d'une alerte : elle doit arriver quand on ne regarde pas.
  socket.on('robot_alerte', async ({ code, type, niveau, photo, capteurs }) => {
    if (!code) return;
    // Seul un robot appaire a CE salon peut donner l'alerte. Sans ce filtre,
    // n'importe quel socket declenchait notifications, analyse Claude et
    // appels Twilio pour le code de son choix.
    const info = users.get(socket.id);
    if (!robots.has(socket.id) || !info || info.code !== code) {
      console.log(`[ALERTE] refusee : ${socket.id} n'est pas le robot du salon '${String(code).slice(0, 64)}'.`);
      return;
    }
    // Le code finit dans un nom de fichier : "../" ecrirait hors du dossier.
    // Un code hors de ce format perd la photo enregistree, jamais l'alerte.
    const codeFichierOk = /^[A-Za-z0-9_-]{1,64}$/.test(String(code));
    if (!codeFichierOk) console.log('[ALERTE] code de salon impropre a un nom de fichier : photo non enregistree.');
    // La photo est conservee sur le disque, pas relayee telle quelle : une
    // image en base64 dans un evenement socket, c'est lourd pour rien quand
    // l'app est fermee — et c'est justement le cas a ce moment-la.
    const tsAlerte = Date.now();
    let fichierPhoto = null;
    if (photo && codeFichierOk) {
      try {
        const fsx = require('fs');
        fsx.mkdirSync(DOSSIER_ALERTES, { recursive: true });
        const octets = Buffer.from(photo, 'base64');
        // Une copie DATEE, gardee : sans elle, chaque alerte effacait la
        // precedente et une notification manquee devenait une alerte perdue.
        fichierPhoto = `${String(code)}-${tsAlerte}.jpg`;
        fsx.writeFileSync(`${DOSSIER_ALERTES}/${fichierPhoto}`, octets);
        // Et la copie "derniere en date", que l'URL des notifications vise.
        fsx.writeFileSync(`${DOSSIER_ALERTES}/${String(code)}.jpg`, octets);
        // Menage : on ne garde que les plus recentes.
        const prefixe = `${String(code)}-`;
        const vieilles = fsx.readdirSync(DOSSIER_ALERTES)
          .filter((f) => f.startsWith(prefixe) && f.endsWith('.jpg'))
          .sort();
        for (const f of vieilles.slice(0, Math.max(0, vieilles.length - ALERTES_GARDEES))) {
          try { fsx.unlinkSync(`${DOSSIER_ALERTES}/${f}`); } catch {}
        }
      } catch (e) {
        console.log('[ALERTE] photo non enregistree :', e.message);
      }
    }
    socket.to(code).emit('robot_alerte', { type, niveau, photo: !!photo });
    logRoomEvent(code, 'robot_alerte', { type, niveau, capteurs });
    try {
      const heure = new Date().toLocaleTimeString('fr-FR');
      // Le radar et le micro ne disent pas la meme chose : "quelqu'un est la"
      // est bien plus fort qu'un bruit, et merite un message different.
      // Que montre la photo ? L'analyse ne doit JAMAIS retarder ni empecher
      // l'alerte : delai maximum de 6 s, et repli sur le message generique.
      // Un faux negatif serait une intrusion manquee — bien plus grave qu'une
      // notification sans description.
      let vu = null;
      if (photo) {
        try {
          vu = await Promise.race([
            require('./voice-brain').decrireScene(Buffer.from(photo, 'base64'), console.log),
            new Promise((r) => setTimeout(() => r(null), 6000)),
          ]);
          if (vu) console.log(`[ALERTE] vu (${vu.categorie}) : ${vu.phrase}`);
        } catch (e) {
          console.log('[ALERTE] analyse impossible :', e.message);
        }
      }

      // Ce que le capteur a senti, en clair.
      const capteur = String(type) === 'presence' ? 'Presence detectee'
        : String(type) === 'mouvement' ? 'Mouvement detecte'
        : 'Bruit detecte';

      // C'est l'IMAGE qui donne le ton, pas le capteur.
      //
      // Un radar ne fait pas la difference entre un chat et quelqu'un : il a
      // declenche des dizaines de fausses alertes. La photo, elle, tranche.
      // Une alerte qui crie au loup pour un chat finit par etre ignoree — et
      // ce jour-la, la vraie passe inapercue.
      let titre;
      if (vu && vu.categorie === 'personne') titre = 'Quelqu un est chez vous';
      else if (vu && vu.categorie === 'animal') titre = 'Ce n est qu un animal';
      else titre = `${capteur} a la maison`;

      // Une PERSONNE sur la photo : en plus du reste, on appelle. Sans await :
      // l'appel ne doit retarder ni Telegram ni la notification. Sa propre
      // cadence (un appel par incident) est independante de celle des notifs.
      if (vu && vu.categorie === 'personne') {
        require('./appel-alerte')
          .appelerAlerte({ code, heure, phrase: vu.phrase, log: console.log })
          .catch((e) => console.log('[APPEL] erreur :', e.message));
      }

      // La description prime sur la formule generique : "Un chat traverse le
      // salon" evite d'ouvrir l'app pour rien.
      const corps = (vu && vu.phrase)
        || (String(type) === 'presence'
          ? 'Le robot detecte quelqu un. Ouvre la camera.'
          : String(type) === 'mouvement'
            ? 'Le robot a vu quelque chose bouger. Ouvre la camera.'
            : 'Le robot a entendu quelque chose. Ouvre la camera pour voir.');
      // Telegram d'abord : c'est le canal qui ne depend d'aucun abonnement.
      await envoyerTelegram(
        `${titre} a ${heure}.
` + `${capteur}. ${corps}` + `
Voir la camera : ${PUBLIC_URL}/ouvrir?code=${encodeURIComponent(String(code))}`
      );
      // Rien n'est perdu : l'alerte entre dans l'historique AVANT toute
      // decision de notification.
      const categorie = (vu && vu.categorie) || 'rien';
      if (!historiqueAlertes.has(code)) historiqueAlertes.set(code, []);
      const hist = historiqueAlertes.get(code);
      const entree = {
        ts: tsAlerte,
        type: String(type || 'bruit'),
        capteurs: Array.isArray(capteurs) ? capteurs : [],
        categorie,
        phrase: (vu && vu.phrase) || null,
        photo: fichierPhoto,
        notifiee: false,
      };
      hist.push(entree);
      if (hist.length > ALERTES_GARDEES) hist.splice(0, hist.length - ALERTES_GARDEES);
      sauverHistorique();

      if (!notifAutorisee(code, categorie)) {
        console.log(`[ALERTE] ${categorie} : notification retenue (cadence), alerte conservee.`);
        return;
      }
      entree.notifiee = true;
      sauverHistorique();

      // Et la notification de l'app, qui reprendra si la cle Apple revient.
      await sendVisiblePushToRoom({
        roomCode: code,
        excludeSocketId: socket.id,
        title: titre,
        body: corps,
        data: { type: 'alerte', kind: String(type || 'bruit') },
        // La photo DANS la notification : on voit ce que le robot a vu sans
        // rien ouvrir. Sert aussi de repli si l'image n'est pas supportee —
        // le champ est alors simplement ignore.
        image: photo ? `${PUBLIC_URL}/alerte-photo?code=${encodeURIComponent(String(code))}&t=${Date.now()}` : null,
      });
    } catch (e) {
      console.log('[ALERTE] notification non envoyee :', e.message);
    }
  });

  // Appel telephonique en cas de personne vue : reglage par robot.
  // Couper les appels ne coupe PAS les notifications.
  socket.on('alerte_appel', ({ actif } = {}) => {
    // Un robot se declare lui-meme : il ne doit pas pouvoir couper les appels.
    if (robots.has(socket.id)) return;
    if (refuseSiPasPilote(socket, 'alerte_appel')) return;
    // Le salon du pilote, PAS le code du message : sinon le pilote d'un salon
    // pourrait couper les appels d'un autre robot.
    const code = (users.get(socket.id) || {}).code;
    if (!code) return;
    const etat = require('./appel-alerte').reglerAppel(code, !!actif);
    console.log(`[APPEL] ${code} : appels ${etat.actif ? 'actifs' : 'coupes'}.`);
    io.to(code).emit('alerte_appel_etat', etat);
  });

  socket.on('alerte_appel_etat', ({ code } = {}) => {
    if (!code) return;
    socket.emit('alerte_appel_etat', require('./appel-alerte').etatAppel(code));
  });

  // Mode de surveillance : NORMAL / ABSENT.
  socket.on('robot_mode', ({ code, absent }) => {
    if (refuseSiPasPilote(socket, 'robot_mode')) return;
    if (!code) return;
    socket.to(code).emit('robot_mode', { absent: !!absent });
    logRoomEvent(code, 'robot_mode', { absent: !!absent });
  });

  socket.on('robot_mode_status', ({ code, absent }) => {
    if (!code) return;
    socket.to(code).emit('robot_mode_status', { absent: !!absent });
  });

  // Alarme : simple relais vers le robot, et retour d'etat vers l'app.
  socket.on('robot_alarme', ({ code, on, texte }) => {
    if (refuseSiPasPilote(socket, 'robot_alarme')) return;
    if (!code) return;
    socket.to(code).emit('robot_alarme', { on: !!on, texte });
    logRoomEvent(code, 'robot_alarme', { on: !!on });
  });

  socket.on('robot_alarme_status', ({ code, on }) => {
    if (!code) return;
    socket.to(code).emit('robot_alarme_status', { on: !!on });
  });

  socket.on('robot_ronde_status', ({ code, ...etat }) => {
    if (!code) return;
    socket.to(code).emit('robot_ronde_status', etat);
  });

  socket.on('robot_status', ({ code, status }) => {
    marquerRobot(socket);
    const sender = users.get(socket.id);
    robotLog(`[ROBOT_STATUS][IN] from=${sender?.pseudo || '?'} code=${code || '?'} fix=${status?.fix ? 'yes' : 'no'} arduino=${status?.arduinoConnected ? 'yes' : 'no'}`);
    if (!code || !status) return;
    socket.to(code).emit('robot_status', {
      ...status,
      by: sender?.pseudo || 'Robot',
      ts: Date.now(),
    });
  });

  // --- Quitter explicitement ---
  socket.on('leave', ({ code }) => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`[LEAVE] '${user.pseudo}' a quitté volontairement la room.`);
      socket.to(code).emit('user_left');

      pushTokens.delete(socket.id);
      const id = socketToUserId.get(socket.id);
      if (id) {
        const p = profiles.get(id);
        if (p) {
          p.online = false;
          p.lastSeen = Date.now();
        }
      }
      users.delete(socket.id);
      socketToUserId.delete(socket.id);
    }
    socket.leave(code);
  });

  // --- Déconnexion OS (app fermée / réseau coupé) ---
  socket.on('disconnect', () => {
    // Depart d'un client : on libere sa place.
    //
    // Si c'est le pilote, un spectateur est promu — sinon le salon resterait
    // en lecture seule jusqu'au prochain redemarrage du serveur.
    {
      const info = users.get(socket.id);
      const code = info && info.code;
      robots.delete(socket.id);
      if (code) {
        fileAttente(code).delete(socket.id);
        groupeSpectateurs(code).delete(socket.id);
        if (pilotes.get(code) === socket.id) {
          pilotes.delete(code);
          console.log(`[ROLE] ${code} : le pilote '${(info && info.pseudo) || '?'}' est parti.`);
          reattribuerPilote(code);
        }
      }
    }

    const user = users.get(socket.id);
    if (!user) return;

    console.log(`[DECONNEXION] '${user.pseudo}' s'est déconnecté. Tolérance ${GRACE_MS/60000} min.`);
    const id = socketToUserId.get(socket.id);
    if (id) {
      const p = profiles.get(id);
      if (p) {
        p.lastSeen = Date.now();
        planMarkOffline(id);
      }
    }
    users.delete(socket.id);
    socketToUserId.delete(socket.id);
    // NE PAS effacer pushTokens persistants (on n'y touche pas ici)
  });

  // --- Se rejoindre ---
  socket.on('request_meet', async ({ code, from }) => {
    if (!code) return;
    const sender = users.get(socket.id);
    const requester = from || sender?.pseudo || 'Ton contact';

    let delivered = false;
    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && socketId !== socket.id) {
        io.to(socketId).emit('meet_request', { from: requester });
        delivered = true;
      }
    }
    if (!delivered) {
      for (const p of profiles.values()) {
        if (p.code === code && p.pseudo !== requester) {
          const otherId = userIdOf(code, p.pseudo);
          enqueueFor(otherId, { type: 'meet_request', payload: { from: requester } });
        }
      }
    }

    logRoomEvent(code, 'meet_request', { from: requester });

    await sendVisiblePushToRoom({
      roomCode: code,
      excludeSocketId: socket.id,
      title: 'Demande “Se rejoindre”',
      body: `${requester} veut te rejoindre.`,
      data: { type: 'meet_request' }
    });
    await sendSilentSyncPushToRoom(code, socket.id);
  });

  socket.on('accept_meet', ({ code }) => {
    if (!code) return;
    const accepter = users.get(socket.id)?.pseudo || 'Ton contact';

    let delivered = false;
    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && socketId !== socket.id) {
        io.to(socketId).emit('meet_accepted', { by: accepter });
        delivered = true;
      }
    }
    if (!delivered) {
      for (const p of profiles.values()) {
        if (p.code === code && p.pseudo !== accepter) {
          const otherId = userIdOf(code, p.pseudo);
          enqueueFor(otherId, { type: 'meet_accepted', payload: { by: accepter } });
        }
      }
    }

    logRoomEvent(code, 'meet_accepted', { by: accepter });

    sendVisiblePushToRoom({
      roomCode: code,
      excludeSocketId: socket.id,
      title: 'Se rejoindre ✅',
      body: `${accepter} a accepté la demande.`,
      data: { type: 'meet_accepted' }
    }).catch(e => console.error('[MEET][accept][PUSH] erreur:', e));

    sendSilentSyncPushToRoom(code, socket.id).catch(() => {});
  });

  socket.on('decline_meet', ({ code }) => {
    if (!code) return;
    const decliner = users.get(socket.id)?.pseudo || 'Ton contact';

    let delivered = false;
    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && socketId !== socket.id) {
        io.to(socketId).emit('meet_declined', { by: decliner });
        delivered = true;
      }
    }
    if (!delivered) {
      for (const p of profiles.values()) {
        if (p.code === code && p.pseudo !== decliner) {
          const otherId = userIdOf(code, p.pseudo);
          enqueueFor(otherId, { type: 'meet_declined', payload: { by: decliner } });
        }
      }
    }

    logRoomEvent(code, 'meet_declined', { by: decliner });
  });

  socket.on('cancel_meet', ({ code }) => {
    if (!code) return;
    let delivered = false;
    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && socketId !== socket.id) {
        io.to(socketId).emit('meet_canceled');
        delivered = true;
      }
    }
    if (!delivered) {
      for (const p of profiles.values()) {
        if (p.code === code) {
          const otherId = userIdOf(code, p.pseudo);
          enqueueFor(otherId, { type: 'meet_canceled', payload: {} });
        }
      }
    }

    logRoomEvent(code, 'meet_canceled', {});
  });

  // --- Partage de position ---
  socket.on('share_location', ({ code, coords }) => {
    if (!code) return;
    socket.to(code).emit('peer_location', { coords });
    logRoomEvent(code, 'peer_location', { coords });

    const me = users.get(socket.id);
    for (const p of profiles.values()) {
      if (p.code === code && (!me || p.pseudo !== me.pseudo)) {
        const otherId = userIdOf(code, p.pseudo);
        enqueueFor(otherId, { type: 'peer_location', payload: { coords } });
      }
    }
  });

  // ===== Salon 24h — SOCKET =====

  // Rejoindre le salon (host ou membre)
  socket.on('lobby_join', async ({ code, pseudo, asHost }) => {
    if (!code || !pseudo) return;
    const lobby = asHost ? startLobbyIfNeeded(code, pseudo) : ensureLobby(code);
    lobby.members.add(pseudo);
    if (asHost) lobby.hosts.add(pseudo);

    socket.join(code);

    socket.to(code).emit('lobby_member_joined', { code, member: { pseudo } });
    logRoomEvent(code, 'lobby_member_joined', { member: { pseudo } });

    await broadcastLobbyState(code);
  });

  // Demande à rejoindre -> notifier uniquement les hôtes
  socket.on('lobby_request', async ({ code, from }) => {
    if (!code || !from) return;
    const lobby = lobbies.get(code);
    if (!lobby || lobby.expiresAt <= Date.now()) return;

    for (const [socketId, userInfo] of users.entries()) {
      if (userInfo.code === code && lobby.hosts.has(userInfo.pseudo)) {
        io.to(socketId).emit('lobby_request', { from, code });
      }
    }

    await sendVisiblePushToPseudos({
      roomCode: code,
      pseudos: [...lobby.hosts],
      title: 'Demande de connexion',
      body: `${from} veut se connecter avec vous`,
      data: { type: 'lobby_request', from }
    });

    logRoomEvent(code, 'lobby_request', { from });
  });

  // Acceptation par un hôte
  socket.on('lobby_accept', async ({ code, target }) => {
    if (!code || !target) return;
    const lobby = lobbies.get(code);
    const actor = users.get(socket.id)?.pseudo;
    if (!lobby || !actor || !lobby.hosts.has(actor)) return;

    lobby.members.add(target);

    io.to(code).emit('lobby_member_joined', { code, member: { pseudo: target } });
    await broadcastLobbyState(code);
    logRoomEvent(code, 'lobby_member_joined', { member: { pseudo: target } });
  });

  socket.on('lobby_decline', async ({ code, target }) => {
    if (!code || !target) return;
    // notifier le target si connecté (et log pour rattrapage)
    io.to(code).emit('lobby_declined', { code, target });
    logRoomEvent(code, 'lobby_declined', { target });
  });

  // Heartbeat socket
  socket.on('lobby_heartbeat', ({ code, pseudo }) => {
    if (!code || !pseudo) return;
    const { id } = ensureProfile(code, pseudo);
    markOnline(id);
  });

  // Quitter le salon
  socket.on('lobby_leave', ({ code, expired }) => {
    if (!code) return;
    const me = users.get(socket.id)?.pseudo;
    const lobby = lobbies.get(code);
    if (!lobby) return;

    if (me) {
      lobby.members.delete(me);
      lobby.hosts.delete(me);
      io.to(code).emit('lobby_member_left', { code, member: { pseudo: me } });
      logRoomEvent(code, 'lobby_member_left', { member: { pseudo: me } });
    }

    if (expired) {
      expireLobby(code);
    } else {
      broadcastLobbyState(code);
      if (lobby.members.size === 0 && lobby.hosts.size === 0) {
        if (lobbyTimers.has(code)) {
          clearTimeout(lobbyTimers.get(code));
          lobbyTimers.delete(code);
        }
        lobbies.delete(code);
      }
    }
  });
});

// ========== HTTP endpoints ==========

// Enregistrement token push (accepte { token, code, pseudo } OU { token, socketId })
// Page-relais vers l'app.
//
// Telegram n'accepte que http(s) dans ses liens : impossible d'y mettre
// "ping://" directement. On passe donc par cette page, qui tente l'ouverture
// automatiquement puis propose un bouton — iOS bloque souvent la redirection
// automatique vers un schema personnalise, mais jamais un tap de l'utilisateur.
// Derniere photo d'alerte du salon, consultee depuis la page /ouvrir — donc
// depuis le telephone, au moment ou l'on decide d'ouvrir l'app ou non.
app.get('/alerte-photo', (req, res) => {
  const code = String(req.query.code || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!code) return res.status(400).send('code requis');
  // Une photo PRECISE de l'historique, ou par defaut la derniere en date.
  // Le nom est filtre puis reconstruit : jamais un chemin venu du client, qui
  // permettrait de lire n'importe quel fichier du serveur.
  const nom = String(req.query.f || '').replace(/[^A-Za-z0-9_-]/g, '');
  const fichier = nom && nom.startsWith(`${code}-`) ? nom : code;
  return res.sendFile(`${DOSSIER_ALERTES}/${fichier}.jpg`, (e) => {
    if (e && !res.headersSent) res.status(404).send('aucune photo');
  });
});

// Historique des alertes : TOUT ce que le robot a signale, y compris ce qui
// n'a volontairement pas declenche de notification. C'est la garantie de ne
// rien rater — le filtrage porte sur la sonnerie, jamais sur la trace.
app.get('/alertes', (req, res) => {
  const code = String(req.query.code || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!code) return res.status(400).json({ erreur: 'code requis' });
  const hist = (historiqueAlertes.get(code) || []).slice().reverse();
  res.json({
    alertes: hist.map((a) => ({
      ts: a.ts,
      type: a.type,
      capteurs: a.capteurs,
      categorie: a.categorie,
      phrase: a.phrase,
      notifiee: a.notifiee,
      photo: a.photo
        ? `${PUBLIC_URL}/alerte-photo?code=${encodeURIComponent(code)}&f=${encodeURIComponent(a.photo.replace(/\.jpg$/, ''))}`
        : null,
    })),
  });
});

// Telechargement d'un enregistrement, pour le ranger dans la galerie du
// telephone. Les videos vivaient jusqu'ici uniquement sur le VPS, sans aucun
// moyen de les recuperer.
app.get('/enregistrement', (req, res) => {
  // Le nom est FILTRE puis reconstruit : jamais un chemin venu du client, qui
  // permettrait de lire n'importe quel fichier du serveur.
  const nom = String(req.query.f || '').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!nom || !nom.endsWith('.mp4') || nom.includes('..')) {
    return res.status(400).send('nom invalide');
  }
  const chemin = require('path').join(process.env.REC_DOSSIER || '/root/enregistrements', nom);
  return res.sendFile(chemin, (e) => {
    if (e && !res.headersSent) res.status(404).send('enregistrement introuvable');
  });
});

// Liste des enregistrements disponibles, du plus recent au plus ancien.
app.get('/enregistrements', (req, res) => {
  const code = String(req.query.code || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!code) return res.status(400).json({ erreur: 'code requis' });
  const fsx = require('fs');
  const dossier = process.env.REC_DOSSIER || '/root/enregistrements';
  let noms = [];
  try {
    noms = fsx.readdirSync(dossier)
      .filter((f) => f.startsWith(`robot-${code}-`) && f.endsWith('.mp4'))
      .sort()
      .reverse();
  } catch {}
  res.json({
    videos: noms.map((f) => {
      let mo = 0;
      try { mo = +(fsx.statSync(`${dossier}/${f}`).size / 1048576).toFixed(1); } catch {}
      return { nom: f, mo, url: `${PUBLIC_URL}/ping/enregistrement?f=${encodeURIComponent(f)}` };
    }),
  });
});

app.get('/ouvrir', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ouvrir Ping</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:18px;background:#070E13;color:#E8FFF8;
       font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:24px}
  img{max-width:100%;border-radius:14px;border:1px solid #1F3C49}
  a{display:block;padding:18px 34px;border-radius:14px;background:rgba(0,229,160,.16);
    border:2px solid #00E5A0;color:#E8FFF8;font-weight:800;font-size:18px;text-decoration:none}
  p{color:#8FB3C2;font-size:14px;margin:0}
</style>
<h2>Alerte a la maison</h2>
<img src="/alerte-photo?code=${encodeURIComponent(String(req.query.code || ''))}&t=${Date.now()}"
     alt="" onerror="this.style.display='none'">
<a href="ping://">Ouvrir Ping</a>
<p>Si rien ne se passe, ouvre l'application manuellement.</p>
<script>setTimeout(function(){ location.href = 'ping://'; }, 250);</script>`);
});

app.post('/register-token', (req, res) => {
  const { token, socketId, code, pseudo } = req.body || {};
  if (!token) return res.status(400).send({ error: 'token manquant' });

  // ancien mapping par socketId (utile si app au 1er plan)
  if (socketId) pushTokens.set(socketId, token);

  // nouveau mapping persistant (permet push app fermée)
  if (code && pseudo) {
    addPersistentToken(String(code), String(pseudo), String(token));
  }
  console.log(
    `[PUSH] jeton recu (code=${code || '-'} pseudo=${pseudo || '-'} ` +
    `valide=${Expo.isExpoPushToken(String(token))} total_salon=${getTokensForRoom(String(code || '')).length})`
  );

  return res.status(200).send({ message: 'Token enregistré' });
});

// Heartbeat HTTP pour salon 24h (utilisé quand l’app est fermée)
app.post('/lobby-heartbeat', (req, res) => {
  const { code, pseudo } = req.body || {};
  if (!code || !pseudo) return res.status(400).send({ error: 'code/pseudo requis' });

  const { id } = ensureProfile(code, pseudo);
  markOnline(id);

  const lobby = lobbies.get(code);
  if (lobby && lobby.expiresAt > Date.now()) {
    lobby.members.add(pseudo);
  }

  return res.status(200).send({ ok: true, expiresAt: lobby ? lobby.expiresAt : 0 });
});

// BG sync déclenchée par push silencieuse
app.post('/robot-drive', (req, res) => {
  const { code, cmd, id, from } = req.body || {};
  const driveCmd = String(cmd || '').trim().toUpperCase();
  const cmdId = String(id || `${driveCmd}-${Date.now()}`);
  robotLog(`[HTTP_ROBOT_DRIVE][IN] id=${cmdId} from=${from || '?'} code=${code || '?'} cmd=${driveCmd}`);

  if (!code || !isDriveCmd(driveCmd)) {
    robotLog(`[HTTP_ROBOT_DRIVE][DROP] id=${cmdId} code=${!!code} cmd=${driveCmd}`);
    return res.status(400).send({ ok: false, error: 'code/cmd invalide', id: cmdId });
  }

  const recipients = [...users.entries()].filter(([, userInfo]) => userInfo.code === code);
  robotLog(
    `[HTTP_ROBOT_DRIVE][ROUTE] id=${cmdId} recipients=${recipients.length} -> ${
      recipients.map(([sid, u]) => `${u.pseudo}@${sid}`).join(',') || 'none'
    }`
  );

  io.to(code).emit('robot_drive', { id: cmdId, cmd: driveCmd, by: from || 'HTTP' });
  logRoomEvent(code, 'robot_drive', { id: cmdId, cmd: driveCmd, by: from || 'HTTP' });

  return res.status(200).send({
    ok: true,
    id: cmdId,
    cmd: driveCmd,
    recipients: recipients.length,
    users: recipients.map(([, u]) => u.pseudo),
  });
});

app.post('/bg-sync', (req, res) => {
  const { code, pseudo } = req.body || {};
  if (!code || !pseudo) return res.status(400).send({ error: 'code/pseudo requis' });

  // Ici tu pourrais renvoyer un delta:
  // const items = getEventsSince(code, since||0);
  // return res.json({ items });

  return res.status(200).send({ ok: true });
});

// ===== Audio robot facon webradio =====
// Le robot POST un flux MP3 continu sur /robot-audio?code=XXX, et chaque app
// qui ecoute fait un GET /robot-audio?code=XXX (lecture type webradio).
// On re-diffuse les chunks du producteur (robot) vers tous les consommateurs.
const audioConsumers = new Map(); // code -> Set<res>

app.post('/robot-audio', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).end();
  console.log(`[AUDIO] producteur connecte code=${code}`);

  req.on('data', (chunk) => {
    const set = audioConsumers.get(code);
    if (!set) return;
    for (const cres of set) {
      try { cres.write(chunk); } catch {}
    }
  });
  const done = () => {
    console.log(`[AUDIO] producteur deconnecte code=${code}`);
    try { res.status(200).end(); } catch {}
  };
  req.on('end', done);
  req.on('close', done);
  req.on('error', done);
});

app.get('/robot-audio', (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) return res.status(400).end();

  // Chaque paquet audio part immediatement (pas de regroupement TCP/Nagle) :
  // toute coalescence = retard audio en plus chez l'auditeur.
  try { res.socket.setNoDelay(true); } catch {}
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
  });

  if (!audioConsumers.has(code)) audioConsumers.set(code, new Set());
  audioConsumers.get(code).add(res);
  console.log(`[AUDIO] auditeur connecte code=${code} (total=${audioConsumers.get(code).size})`);

  const cleanup = () => {
    const set = audioConsumers.get(code);
    if (set) {
      set.delete(res);
      if (set.size === 0) audioConsumers.delete(code);
    }
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

// Healthcheck
app.get('/', (_, res) => res.send('OK'));

// --- Lancement serveur ---
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;

  if (PORT !== DEFAULT_PORT) {
    console.error(`Port ${PORT} deja utilise, bascule sur le port robot ${DEFAULT_PORT}.`);
    PORT = DEFAULT_PORT;
    server.listen(PORT);
    return;
  }

  console.error(`Port ${PORT} deja utilise. Arrete le process qui occupe ce port ou change PORT.`);
  process.exit(1);
});

server.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
