// realtime-voix.js - Conversation vocale EN DIRECT avec la Realtime d'OpenAI.
//
// Difference avec voice-brain.js : celui-ci fonctionne au tour par tour. Il
// enregistre un fichier, le transcrit (Deepgram), interroge Claude, synthetise
// la reponse, puis la joue — six a dix secondes.
//
// Ici, le robot pousse son micro en continu vers le VPS, qui le relaie a un
// modele voix-a-voix. Celui-ci entend, comprend, decide et repond lui-meme en
// audio. On tombe autour de la seconde, et on peut lui couper la parole.
//
// CE QUI EST REUTILISE : les outils du robot (piloter, regarder, ronde,
// bouger_camera...) et sa personnalite viennent de voice-brain.js. Seules
// leurs DECLARATIONS sont converties au format OpenAI ; les implementations
// sont rigoureusement les memes. Deux copies divergeraient au premier ajout.
//
// Prerequis : OPENAI_API_KEY dans /root/server/.env
'use strict';

const WebSocket = require('ws');
const { TOOLS, SYSTEM_PROMPT, runTool } = require('./voice-brain');

const MODEL = process.env.REALTIME_MODEL || 'gpt-realtime-2.1';
const URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
// Voix du modele. 'marin' et 'cedar' sont les plus naturelles ; la voix ne
// peut PAS etre changee une fois la session ouverte.
const VOIX = process.env.REALTIME_VOICE || 'marin';
// PCM 16 bits, 24 kHz, mono : impose par l'API dans les deux sens. Le robot
// doit capturer et jouer exactement a cette frequence.
const TAUX = 24000;
// Au-dela, on ferme la session : une session oubliee ouverte continue de
// facturer de l'audio a la minute.
const INACTIVITE_MS = Number(process.env.REALTIME_IDLE_MS || 120000);

// Detection de tour de parole.
//
// 'semantic_vad' laisse un modele juger si la phrase est finie : agreable
// entre humains, mais il accepte trop facilement le bruit d'un robot (moteurs,
// echo de l'enceinte, piece vivante) comme un debut de parole. Resultat
// constate le 08/08 : des tours fantomes transcrits en chinois, auxquels
// l'assistant repondait serieusement.
//
// 'server_vad' decide sur l'ENERGIE, avec un seuil qu'on maitrise. C'est ce
// qu'il faut ici : un robot est une machine bruyante. Reglable sans toucher au
// code, le temps de trouver le bon point sur le terrain.
const VAD = process.env.REALTIME_VAD || 'server';
const VAD_SEUIL = Number(process.env.REALTIME_VAD_SEUIL || 0.7);
const DETECTION_TOUR =
  VAD === 'semantic'
    ? { type: 'semantic_vad', eagerness: process.env.REALTIME_VAD_ARDEUR || 'low' }
    : {
        type: 'server_vad',
        threshold: VAD_SEUIL,          // 0..1 — monte-le si le bruit declenche
        prefix_padding_ms: 300,        // garde le debut du mot
        silence_duration_ms: 700,      // silence avant de considerer le tour fini
      };

// ============================================================
// Veille : la session reste ouverte, l'assistant ne repond pas
// ============================================================
//
// Le but : laisser la conversation branchee en permanence sans que le robot
// commente la vie de la maison — et sans mot-cle local. openWakeWord faisait
// ce travail sur le Pi, mais il y charge onnxruntime et numpy : beaucoup de
// memoire sur une machine qui fait deja tourner la camera, la surveillance et
// les moteurs.
//
// Ici le reveil est decide SUR LE SERVEUR, dans le texte deja transcrit. Cout
// en memoire sur le Pi : zero. Et la session ouverte ne consomme rien tant que
// personne ne parle, puisque la detection d'energie d'OpenAI filtre en amont.
//
// Une fois reveille, l'assistant reste disponible : on ne va pas redire son
// nom a chaque phrase d'une meme conversation. Il se rendort apres un silence.
const VEILLE = String(process.env.REALTIME_VEILLE || 'true').toLowerCase() === 'true';
// Tolerant a la transcription : elle ecrit rarement un prenom rare deux fois
// de la meme facon. Un mot de reveil qu'il faut repeter trois fois ne sert a
// rien, donc on accepte les deformations proches.
const MOT_REVEIL = new RegExp(
  process.env.REALTIME_MOT_REVEIL || '\\b(solana|sol ana|solanna|solana|solene|solenna)\\b',
  'i'
);
// Duree pendant laquelle il reste eveille apres la derniere parole.
const VEILLE_DELAI_MS = Number(process.env.REALTIME_VEILLE_MS || 90000);
const MOT_REVEIL_LISIBLE = process.env.REALTIME_MOT_REVEIL_LISIBLE || 'Salut Solana';

// Enleve accents et ponctuation : la transcription ecrit "Solana," ou
// "Salut, Solana !", et un test brut passerait a cote.
function sansAccents(t) {
  return String(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Convertit un outil Anthropic ({name, description, input_schema}) vers le
// format attendu par la Realtime ({type, name, description, parameters}).
function outilsOpenAI() {
  return TOOLS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

class SessionVocale {
  // Options pour une autre ligne que le micro du robot (le telephone, voir
  // appel-direct.js) :
  //   veille        mot de reveil exige ? (par defaut : REALTIME_VEILLE)
  //   annoncer      diffuser l'etat de veille a l'app (le bandeau)
  //   formatAudio   format OpenAI des deux sens (le telephone parle en mu-law)
  //   detection     reglage de detection de tour de parole
  //   consignes     texte ajoute aux instructions
  //   outils        outils propres a cette ligne : [{ declaration, executer }]
  //   accueil       message qui fait parler le modele EN PREMIER a l'ouverture
  //   image         () => Buffer|null, image servie a l'outil 'regarder'
  //   etiquette     prefixe des journaux
  constructor({ code, io, log, onAudio, onEtat, ...opts }) {
    this.code = code;
    this.veille = opts.veille !== undefined ? !!opts.veille : VEILLE;
    this.annoncer = opts.annoncer !== false;
    this.formatAudio = opts.formatAudio || { type: 'audio/pcm', rate: TAUX };
    this.detection = opts.detection || DETECTION_TOUR;
    this.consignes = opts.consignes || '';
    this.outilsEnPlus = opts.outils || [];
    this.accueil = opts.accueil || null;
    this.imageFournie = opts.image || null;
    this.etiquette = opts.etiquette || 'RT';
    this.io = io;
    this.log = log || console.log;
    // Renvoie un morceau de PCM au robot.
    this.onAudio = onAudio || (() => {});
    this.onEtat = onEtat || (() => {});
    this.ws = null;
    this.prete = false;
    this.dernierEchange = Date.now();
    this._minuteur = null;
    // Derniere image recue du robot, servie a l outil 'regarder'. En direct,
    // aucune question ne porte d image : le robot la pousse periodiquement.
    this.image = null;
    this.ouverteA = 0;        // pour mesurer la duree de vie de la session
    this.reponses = 0;        // nombre de reponses effectivement produites
    this.reponseEnCours = false; // le modele est-il en train de repondre ?
    // On demarre EN VEILLE quand le mot de reveil est actif.
    //
    // J'avais d'abord fait l'inverse, en jugeant absurde d'exiger le nom juste
    // apres un appui sur le bouton. Le besoin reel est l'autre : le bouton
    // OUVRE le micro, le nom LANCE l'echange. Sans ca, le robot commente la
    // premiere phrase prononcee dans la piece, qui ne lui etait pas adressee.
    this.eveille = !this.veille;
    this.veilleTimer = null;
    if (this.veille) this.log(`[${this.etiquette}] code=${this.code} en veille, dites "${MOT_REVEIL_LISIBLE}" pour parler.`);
  }

  ouvrir() {
    const cle = process.env.OPENAI_API_KEY;
    if (!cle) {
      this.log('[RT] OPENAI_API_KEY absente -> mode temps reel indisponible.');
      return false;
    }
    if (this.ws) return true;

    this.ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${cle}` } });

    this.ws.on('open', () => {
      this.log(`[${this.etiquette}] code=${this.code} session ouverte (${MODEL}, voix ${VOIX}).`);
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          // Meme personnalite que le mode tour par tour, plus une consigne
          // propre au direct : en conversation, les longues tirades sont
          // insupportables — et on peut de toute facon relancer.
          instructions:
            SYSTEM_PROMPT +
            "\n\nTu es maintenant en conversation VOCALE DIRECTE. Reponds en une ou deux " +
            "phrases courtes, comme on parle. Si tu dois agir, agis d'abord et commente " +
            "en une phrase. N'enumere jamais de listes a voix haute." +
            (this.consignes ? '\n\n' + this.consignes : ''),
          audio: {
            input: {
              format: this.formatAudio,
              // Detection de tour de parole cote OpenAI : c'est elle qui
              // decide quand l'utilisateur a fini, et qui declenche
              // l'interruption quand il reprend la parole.
              // create_response: false -> OpenAI detecte et transcrit les
              // tours de parole, mais ne repond JAMAIS de lui-meme. C'est le
              // serveur qui decide, apres avoir lu ce qui a ete dit. Sans ca
              // une veille est impossible : le modele repondrait avant qu'on
              // ait pu regarder si son nom avait ete prononce.
              turn_detection: this.veille
                ? { ...this.detection, create_response: false }
                : this.detection,
              // Transcrit ce que le modele ENTEND. Sans ca, les journaux ne
              // montrent que les reponses : quand le robot dit "je n'ai pas
              // compris", rien ne permet de savoir s'il a recu de la parole,
              // de l'echo ou du silence.
              //
              // La langue est IMPOSEE : sans elle, le bruit ambiant se faisait
              // transcrire en chinois ou en letton ("Sīk.", "幾號月啦?"), et le
              // modele repondait serieusement a ces tours fantomes.
              transcription: { model: 'gpt-4o-mini-transcribe', language: 'fr' },
            },
            output: { format: this.formatAudio, voice: VOIX },
          },
          tools: [...outilsOpenAI(), ...this.outilsEnPlus.map((o) => o.declaration)],
          tool_choice: 'auto',
        },
      }));
      this.prete = true;
      this.ouverteA = Date.now();
      this.reponses = 0;
      this.onEtat({ actif: true });
      // L'app garde le dernier etat recu : sans cet envoi, elle afficherait
      // celui de la session precedente (souvent "ecoute") alors que celle-ci
      // demarre en veille.
      this._annoncerVeille();
      this._armerInactivite();
      // Le modele parle d'abord : au telephone, c'est lui qui appelle, il doit
      // dire pourquoi des qu'on decroche.
      if (this.accueil) {
        this._envoyer({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: this.accueil }] },
        });
        this._envoyer({ type: 'response.create' });
      }
    });

    this.ws.on('message', (brut) => this._surEvenement(brut));

    // Le code et le motif sont indispensables : sans eux, impossible de savoir
    // si c'est le robot qui raccroche (rt_stop), OpenAI qui ferme, ou une
    // coupure reseau. 1000 = fermeture normale demandee de notre cote.
    this.ws.on('close', (code, motif) => {
      const txt = motif ? Buffer.from(motif).toString().slice(0, 200) : '';
      this.log(
        `[${this.etiquette}] code=${this.code} session fermee` +
        ` (code=${code}${txt ? ', motif=' + txt : ''}` +
        `, ${Math.round((Date.now() - this.ouverteA) / 1000)}s, ${this.reponses} reponse(s)).`
      );
      this._nettoyer();
    });

    this.ws.on('error', (e) => {
      this.log(`[${this.etiquette}] code=${this.code} erreur : ${e.message}`);
      this._nettoyer();
    });

    return true;
  }

  _surEvenement(brut) {
    let ev;
    try {
      ev = JSON.parse(brut.toString());
    } catch {
      return;
    }

    switch (ev.type) {
      // L'utilisateur se met a parler : on coupe immediatement la lecture en
      // cours sur le robot. C'est ce qui permet de lui couper la parole.
      case 'input_audio_buffer.speech_started':
        this.onEtat({ interrompre: true });
        break;

      case 'response.output_audio.delta':
        if (ev.delta) this.onAudio(Buffer.from(ev.delta, 'base64'));
        break;

      // Suivi de l'etat reel du modele : sans lui, on demandait l'annulation
      // d'une reponse deja terminee et l'API repondait
      // "response_cancel_not_active" a chaque fois.
      case 'response.created':
        this.reponseEnCours = true;
        break;

      case 'response.output_audio.done':
        this.reponses++;
        this.onEtat({ finReponse: true });
        break;

      // Transcription de ce que le modele dit : utile pour l'app et les logs.
      case 'response.output_audio_transcript.done':
        if (ev.transcript) this.log(`[${this.etiquette}] code=${this.code} robot: "${ev.transcript}"`);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) {
          this.log(`[${this.etiquette}] code=${this.code} entendu: "${ev.transcript}"`);
          // Renvoye au robot (et a l'app) : c'est la seule facon de savoir,
          // depuis le terrain, a QUOI l'assistant vient de repondre.
          this.io.to(this.code).emit('rt_entendu', { texte: ev.transcript });

          if (this.veille) {
            const dit = sansAccents(ev.transcript);
            if (MOT_REVEIL.test(dit)) {
              this._reveiller('nom prononce');
            } else if (!this.eveille) {
              // En veille et le nom n'a pas ete dit : on a entendu, on ne
              // repond pas. La phrase reste dans le contexte, donc s'il
              // enchaine avec "Solana", ce qui precede garde du sens.
              this.log(`[${this.etiquette}] code=${this.code} en veille, pas de reponse.`);
              break;
            } else {
              // Deja eveille : toute parole repousse le retour en veille.
              this._programmerVeille();
            }
          }

          // C'est NOUS qui demandons la reponse quand la session est configuree
          // pour ne jamais repondre d'elle-meme (veille). Sans veille, OpenAI
          // repond deja seul : la redemander ferait parler le modele deux fois.
          if (this.veille && !this.reponseEnCours) this._envoyer({ type: 'response.create' });
        } else if (this.veille && this.eveille) {
          // Transcription vide ou en echec, alors qu'on attend une reponse.
          // Comme c'est desormais NOUS qui la demandons, ne rien faire ici
          // laisserait l'assistant definitivement muet — une panne silencieuse,
          // impossible a distinguer d'un micro qui ne capte plus. On repond
          // donc quand meme : le modele a l'audio, meme sans son texte.
          this.log(`[${this.etiquette}] code=${this.code} tour sans transcription -> reponse demandee quand meme.`);
          if (!this.reponseEnCours) this._envoyer({ type: 'response.create' });
        }
        break;

      case 'response.done':
        this.reponseEnCours = false;
        this._traiterOutils(ev);
        break;

      case 'error':
        this.log(`[${this.etiquette}] code=${this.code} erreur API : ${JSON.stringify(ev.error || ev).slice(0, 300)}`);
        break;

      default:
        break;
    }
    this.dernierEchange = Date.now();
  }

  // Le modele a demande un ou plusieurs outils : on les execute avec les
  // MEMES fonctions que le mode tour par tour, puis on lui rend la main.
  // Rendormir apres un silence, pour ne pas rester eveille toute la journee
  // sur une phrase prononcee le matin.
  _programmerVeille() {
    if (this.veilleTimer) clearTimeout(this.veilleTimer);
    this.veilleTimer = setTimeout(() => {
      this.veilleTimer = null;
      if (!this.eveille) return;
      this.eveille = false;
      this.log(`[${this.etiquette}] code=${this.code} retour en veille.`);
      this._annoncerVeille();
    }, VEILLE_DELAI_MS);
    if (this.veilleTimer.unref) this.veilleTimer.unref();
  }

  _reveiller(raison) {
    if (!this.eveille) {
      this.eveille = true;
      this.log(`[${this.etiquette}] code=${this.code} reveil (${raison}).`);
      this._annoncerVeille();
    }
    this._programmerVeille();
  }

  // Etat complet, pas seulement la transition : l'app affiche aussi la phrase
  // a prononcer, qui se regle ici (REALTIME_MOT_REVEIL_LISIBLE).
  etatVeille() {
    return { eveille: this.eveille, veille: this.veille, phrase: MOT_REVEIL_LISIBLE };
  }

  _annoncerVeille() {
    if (!this.annoncer) return;
    this.io.to(this.code).emit('rt_veille', this.etatVeille());
  }

  async _traiterOutils(ev) {
    const sorties = (ev.response && ev.response.output) || [];
    const appels = sorties.filter((o) => o && o.type === 'function_call');
    if (!appels.length) return;

    for (const appel of appels) {
      let entree = {};
      try {
        entree = JSON.parse(appel.arguments || '{}');
      } catch {}
      let texte = '';
      let images = [];
      try {
        const propre = this.outilsEnPlus.find((o) => o.declaration.name === appel.name);
        const blocs = propre ? await propre.executer(entree) : await runTool(appel.name, entree, {
          io: this.io,
          code: this.code,
          frame: this.imageFournie ? this.imageFournie() : this.image,
          log: this.log,
          // Pas de "client: null" ici : runTool va chercher lui-meme le client
          // Claude dont ses outils de vision ont besoin.
        });
        texte = (blocs || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ');
        // Les outils renvoient leurs images au format Anthropic. On ne les
        // jetait pas par choix mais par oubli : le modele recevait "Image en
        // direct de la camera" SANS l'image, et brodait donc dans le vide
        // ("je vois le flux mais rien ne ressort nettement").
        images = (blocs || [])
          .filter((b) => b.type === 'image' && b.source && b.source.data)
          .map((b) => `data:${b.source.media_type || 'image/jpeg'};base64,${b.source.data}`);
      } catch (e) {
        texte = `Erreur outil : ${e.message}`;
      }
      this.log(
        `[${this.etiquette}] code=${this.code} outil ${appel.name} -> ${texte.slice(0, 80)}` +
        (images.length ? ` [+${images.length} image]` : '')
      );
      this._envoyer({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: appel.call_id,
          output: JSON.stringify({ resultat: texte }),
        },
      });
      // Le resultat d'un outil ne peut pas porter d'image : on la joint donc
      // comme un message a part, juste apres. Le modele l'a alors sous les yeux
      // au moment de rediger sa reponse.
      for (const url of images) {
        this._envoyer({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: url }],
          },
        });
      }
    }
    // Sans ce response.create, le modele attend indefiniment apres l'outil.
    this._envoyer({ type: 'response.create' });
  }

  _envoyer(objet) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(objet));
    }
  }

  // Un morceau de micro arrive du robot.
  pousserAudio(pcm) {
    if (!this.prete || !pcm || !pcm.length) return;
    this.dernierEchange = Date.now();
    this._envoyer({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(pcm).toString('base64'),
    });
  }

  // Une session oubliee ouverte facture de l'audio a la minute : on la ferme
  // apres un silence prolonge, le robot la rouvrira au prochain appui.
  _armerInactivite() {
    clearInterval(this._minuteur);
    this._minuteur = setInterval(() => {
      if (Date.now() - this.dernierEchange > INACTIVITE_MS) {
        this.log(`[${this.etiquette}] code=${this.code} inactive -> fermeture (economie).`);
        this.fermer();
      }
    }, 15000);
  }

  fermer() {
    try {
      if (this.ws) this.ws.close();
    } catch {}
    this._nettoyer();
  }

  _nettoyer() {
    clearInterval(this._minuteur);
    this._minuteur = null;
    // Sinon ce minuteur survit a la session et peut annoncer "en veille"
    // jusqu'a 90 s plus tard, pendant qu'une NOUVELLE session ecoute.
    if (this.veilleTimer) clearTimeout(this.veilleTimer);
    this.veilleTimer = null;
    this.ws = null;
    this.prete = false;
    this.onEtat({ actif: false });
  }
}

/**
 * Branche le mode conversation temps reel sur le serveur socket.io.
 * Evenements attendus du robot :
 *   rt_start {code}        ouvre la session
 *   rt_audio {code, pcm}   morceau de micro (PCM16 24 kHz mono)
 *   rt_stop  {code}        ferme la session
 * Evenements renvoyes au robot :
 *   rt_audio_out (PCM a jouer) | rt_couper | rt_etat
 */
function attachRealtimeVoix(io, log = console.log) {
  const sessions = new Map(); // code -> SessionVocale

  const obtenir = (code) => {
    let s = sessions.get(code);
    if (s && s.ws) return s;
    s = new SessionVocale({
      code,
      io,
      log,
      onAudio: (pcm) => io.to(code).emit('rt_audio_out', { pcm }),
      onEtat: (etat) => {
        if (etat.interrompre) io.to(code).emit('rt_couper', {});
        else io.to(code).emit('rt_etat', etat);
        if (etat.actif === false) sessions.delete(code);
      },
    });
    sessions.set(code, s);
    return s;
  };

  io.on('connection', (socket) => {
    socket.on('rt_start', (p) => {
      const code = p && p.code;
      if (!code) return;
      const s = obtenir(code);
      if (!s.ouvrir()) io.to(code).emit('rt_etat', { actif: false, erreur: 'cle OpenAI absente' });
    });

    // L'app (re)connectee demande l'etat courant : rt_veille n'est emis
    // qu'aux transitions, elle ne le connaitrait sinon qu'au prochain
    // changement.
    socket.on('rt_veille_etat', (p) => {
      const code = p && p.code;
      const s = code && sessions.get(code);
      if (s && s.ws) socket.emit('rt_veille', s.etatVeille());
    });

    socket.on('rt_audio', (p) => {
      const code = p && p.code;
      if (!code) return;
      const s = sessions.get(code);
      if (s) s.pousserAudio(p.pcm);
    });

    // Le robot a decide localement qu'on lui coupait la parole. On annule
    // la reponse en cours cote OpenAI : sinon il continue de generer de
    // l'audio (et de le facturer) pour une phrase que personne n'ecoute.
    // Image poussee par le robot pendant la conversation (voir rt_frame
    // cote robot). On garde la derniere : l'outil 'regarder' la trouvera
    // prete, sans aller-retour supplementaire au moment ou l'IA la demande.
    socket.on('rt_frame', (p) => {
      const code = p && p.code;
      const s = code && sessions.get(code);
      if (s && p.frame) s.image = Buffer.from(p.frame);
    });

    socket.on('rt_interrompre', (p) => {
      const code = p && p.code;
      const s = code && sessions.get(code);
      if (!s) return;
      // N'annuler que s'il y a vraiment quelque chose a annuler.
      if (s.reponseEnCours) {
        s._envoyer({ type: 'response.cancel' });
        s.reponseEnCours = false;
      }
      s._envoyer({ type: 'input_audio_buffer.clear' });
    });

    socket.on('rt_stop', (p) => {
      const code = p && p.code;
      const s = code && sessions.get(code);
      if (s) {
        log(`[RT] code=${code} arret demande par le robot (rt_stop).`);
        s.fermer();
      }
    });

    // Le robot n'a pas de raison de disparaitre en pleine conversation, mais
    // si sa liaison tombe (coupure 4G, timeout socket.io), la session OpenAI
    // resterait ouverte et facturee. On la ferme, et surtout on le DIT.
    socket.on('disconnect', () => {
      for (const [code, s] of sessions) {
        if (s.ws && !io.sockets.adapter.rooms.get(code)) {
          log(`[RT] code=${code} plus personne dans la room -> fermeture.`);
          s.fermer();
        }
      }
    });
  });

  log(
    process.env.OPENAI_API_KEY
      ? `[RT] Mode conversation temps reel pret (${MODEL}, voix ${VOIX}, ${TAUX} Hz).`
      : '[RT] Mode temps reel INACTIF : OPENAI_API_KEY absente de /root/server/.env'
  );
}

module.exports = { attachRealtimeVoix, SessionVocale, TAUX };
