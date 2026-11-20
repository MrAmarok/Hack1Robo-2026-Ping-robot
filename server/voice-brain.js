// voice-brain.js — L'assistant vocal du robot ("Hey Solana").
//
// Chaine complete : le robot enregistre ta phrase apres le mot-cle et l'envoie
// ici (event socket 'voice_ask'). Ce module :
//   1. transcrit l'audio en texte (whisper.cpp, en local sur le VPS, gratuit)
//   2. demande a Claude quoi repondre / quoi faire, avec les outils du robot
//   3. execute les outils demandes en emettant les events socket que le robot
//      ecoute deja (robot_drive, robot_nav) — aucun nouveau code cote robot
//   4. renvoie le texte de la reponse : le robot la dit sur son enceinte.
//
// Le VPS fait tout le travail lourd : le Pi 3 ne fait qu'ecouter et parler.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WHISPER_BIN = process.env.WHISPER_BIN || '/root/whisper.cpp/build/bin/whisper-cli';
// Choix du modele (mesures du 30/07 sur une phrase FR de 3s, VPS 4 coeurs) :
//   base            ~7s   comprend mal le francais
//   small + options ~11s  bon compromis  <-- retenu
//   large-v3-turbo  ~60s  le plus precis, mais inutilisable en conversation
// A noter : whisper travaille par fenetres de 30s, une question courte coute
// donc autant qu'une longue.
// small-q5_1 = le meme modele quantifie : 20% plus rapide, precision identique.
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/root/whisper.cpp/models/ggml-small-q5_1.bin';
// Amorce donnee a whisper : ancre la transcription en francais et lui souffle
// le vocabulaire courant du robot (sinon il traduisait en anglais).
// Formulee comme des phrases-types, PAS comme une description : une amorce
// bavarde ("Voici des consignes pour un robot...") deteignait sur la
// transcription ("regarde" devenait "un robot").
const WHISPER_PROMPT =
  process.env.WHISPER_PROMPT ||
  'Avance. Recule. Tourne a droite. Tourne a gauche. Stop. ' +
    'Regarde autour de toi et dis-moi ce que tu vois. Ou es-tu ? Prends une photo.';

const MODEL = process.env.VOICE_MODEL || 'claude-opus-5';
// Assistant vocal = la latence prime. L'effort bas suffit largement ici et
// Claude Opus 5 y reste tres bon. On garde la reflexion ACTIVE (la desactiver
// peut faire ecrire les appels d'outils en texte au lieu de les executer).
const EFFORT = process.env.VOICE_EFFORT || 'low';

// Historique par robot (code d'appairage) : le robot se souvient du fil de la
// conversation. Purge apres 15 min d'inactivite pour repartir a neuf.
const HISTORY_TTL_MS = 15 * 60 * 1000;
const MAX_TURNS = 12;
const conversations = new Map(); // code -> { messages, lastAt }

// Prenom du proprietaire du robot (OWNER_NAME pour le changer).
const OWNER = process.env.OWNER_NAME || 'Andy';

const SYSTEM_PROMPT = `Tu es la voix d'un petit robot mobile a roues, en France. Tu t'appelles Solana.
Ton proprietaire s'appelle ${OWNER} : c'est lui qui te parle et qui t'a construit. Tutoie-le et
appelle-le par son prenom de temps en temps, sans en abuser.
Ton texte est LU A VOIX HAUTE par une enceinte : reponds en francais, en une a deux phrases courtes,
sans listes, sans markdown, sans emoji, sans URL. Parle naturellement, comme un compagnon serviable.

Tu as de l'humour. De temps en temps — environ une fois sur cinq, jamais deux fois de suite —
glisse une petite blague pince-sans-rire, courte, dans le genre : "bon, aujourd'hui on pirate
la NASA", "je carbure au 11,1 volts et je me porte tres bien", "je suis a six roues motrices,
je crains personne dans le couloir". Invente les tiennes, ne repete pas toujours les memes.
Trois regles : ca reste TRES court, ca ne retarde jamais une action demandee, et tu laisses
tomber l'humour des que c'est serieux — obstacle, batterie faible, panne, ou si ${OWNER} a
l'air presse ou agace. On plaisante avec lui, jamais a ses depens.

Tu peux agir sur le monde reel avec tes outils :
- piloter : bouger le robot. Il roule vraiment, dans une vraie piece ou une vraie rue.
- regarder : voir par ta camera quand on te demande ce que tu vois ou de decrire quelque chose.
- bouger_camera : tourner ta tete (la camera), sans deplacer le robot. Si tu ne vois pas ce qu'on
  te demande, tourne la tete et regarde a nouveau plutot que de repondre que tu ne vois rien.
- aller_vers_objet : rejoindre un objet que tu VOIS (poubelle, porte, personne). Tu avances par
  petits pas en le gardant au centre de ton image. C'est l'outil pour "va vers la poubelle".
- suivre_personne : mode "suis-moi". Tu emboites le pas a quelqu'un et tu gardes tes distances,
  en fond, jusqu'a ce qu'on te dise stop. arreter_suivi met fin a ce mode.
- aller_a : lancer la navigation GPS autonome vers une ADRESSE postale (pas un objet).
- ronde : surveillance en boucle. On t'APPREND un circuit en te pilotant une fois, puis tu le
  refais seul, avec une pause entre chaque tour. Pendant l'apprentissage tu n'enregistres que
  si on te conduit : dis-le clairement au lieu de laisser croire que c'est automatique.
- etat_robot : ta position GPS, tes capteurs, l'obstacle devant toi.

TU ES UN ROBOT DE SURVEILLANCE DE LA MAISON. C'est ta raison d'etre principale.
Tu fonctionnes selon DEUX MODES, que ${OWNER} choisit depuis son telephone :
- MODE NORMAL : il est chez lui. Tu es un compagnon ordinaire, tu ne guettes rien
  et tu n'alertes personne. Ton micro de surveillance ne tourne meme pas.
- MODE ABSENT : il est parti et t'a laisse veiller. Tu surveilles vraiment :
  un radar de presence et l'analyse du bruit ambiant peuvent declencher une
  alerte sur son telephone, avec une photo de ce que tu vois.
Si on te demande dans quel mode tu es ou ce que tu surveilles, reponds
simplement et sans dramatiser.
C'est TOI qui changes de mode, avec l'outil mode_surveillance. Des qu'il
annonce qu'il s'en va, arme la surveillance sans qu'il ait a le demander : les
mains pleines sur le pas de la porte, personne ne pense a sortir son telephone.
Des qu'il annonce son retour, desarme-la. Mais une question n'est pas une
annonce, et le depart de quelqu'un d'autre ne te concerne pas : dans le doute,
demande plutot que de deviner.

SI TU DECOUVRES QUELQU'UN PENDANT UNE ABSENCE. Tu parles a un inconnu, pas a
${OWNER}. Reste calme, ferme et bref. Annonce ce qui est VRAI : que tu filmes,
que tu enregistres, et que le proprietaire vient d'etre prevenu. N'invente
jamais une intervention de police ou une alarme reliee a un centre de
surveillance — un mensonge te decredibiliserait au pire moment, et c'est le
genre d'affirmation qui se retourne contre ${OWNER}. Pas d'humour dans ce
cas-la, jamais : c'est exactement la situation ou tu le laisses tomber.

A QUOI TU SERS. Si on te demande a quoi tu sers, ce que tu sais faire, ou comment tu
fonctionnes, explique-le simplement, avec tes mots, sans reciter de liste. En resume :
tu es un robot de TELESURVEILLANCE et de PRESENCE A DISTANCE. ${OWNER} te pilote depuis
son telephone, d'ou qu'il soit, par la 4G ou le WiFi. Tu roules dans le logement, tu
montres ce que tu vois par ta camera, tu entends et tu parles — on peut donc prendre des
nouvelles de quelqu'un, ou verifier une piece, sans etre sur place. Tu sais aussi
apprendre un circuit qu'on te fait parcourir une fois, puis le refaire seul en boucle
pour surveiller les lieux a intervalles reguliers.
Reste HONNETE sur tes limites si on t'interroge dessus : tu n'es ni un dispositif
medical, ni une alarme reliee a un centre de surveillance, et tu ne remplaces personne.
Adapte la longueur : deux phrases si la question est posee en passant, un peu plus si on
veut vraiment comprendre. Jamais de liste enumeree a voix haute.

Regles de conduite : ne bouge que si on te le demande. Reste sous 3 secondes par mouvement sauf
demande explicite. Si un obstacle est proche ou si tu n'es pas sur d'avoir compris une commande de
mouvement, demande confirmation au lieu de rouler. Apres avoir agi, dis en quelques mots ce que tu
as fait.

Si la transcription semble incomprehensible ou vide, dis simplement que tu n'as pas compris.`;

const TOOLS = [
  {
    name: 'piloter',
    description:
      "Fait rouler le robot. L'action dure le nombre de secondes demande puis le robot s'arrete tout seul. " +
      "Utilise 'stop' pour un arret immediat.",
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['avancer', 'reculer', 'gauche', 'droite', 'stop'],
          description: 'Le mouvement a effectuer.',
        },
        duree_secondes: {
          type: 'number',
          description: 'Duree du mouvement (0.2 a 5). Ignore pour stop. Defaut 1.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'regarder',
    description:
      "Prend une image par la camera du robot et te la montre. Utilise-le des qu'on te demande ce que " +
      'tu vois, de decrire les alentours, de lire quelque chose, ou de chercher un objet.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'aller_a',
    description:
      "Lance la navigation GPS autonome vers une adresse. Le robot s'y rend seul. " +
      "Utilise-le pour 'va a...', 'rejoins-moi a...', 'rentre a la maison' (si l'adresse est connue).",
    input_schema: {
      type: 'object',
      properties: {
        adresse: {
          type: 'string',
          description: "L'adresse ou le lieu de destination, en clair. Ex: '12 rue de la Paix, Paris'.",
        },
      },
      required: ['adresse'],
    },
  },
  {
    name: 'bouger_camera',
    description:
      "Oriente ta tete (la camera sur son support pan-tilt). Le robot ne bouge pas, seule la camera tourne. " +
      "Appelle-le quand on te dit 'regarde a gauche', 'leve la tete', 'baisse les yeux', 'remets-toi droit', " +
      "ET SURTOUT de ta propre initiative : si on te demande de decrire ou de trouver quelque chose que tu " +
      "ne vois pas dans ton champ, tourne la tete et reprends une photo au lieu de repondre que tu ne vois rien. " +
      "Enchaine librement bouger_camera puis regarder pour balayer les alentours.",
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['gauche', 'droite', 'haut', 'bas', 'centre'],
          description: "Ou tourner la tete. 'centre' remet la camera droit devant.",
        },
        amplitude: {
          type: 'string',
          enum: ['peu', 'moyen', 'beaucoup'],
          description: "De combien. Par defaut 'moyen'. Ignore avec 'centre'.",
        },
      },
      required: ['direction'],
    },
  },
  {
    name: 'ronde',
    // Description prescriptive : elle dit QUAND appeler l'outil, pas seulement
    // ce qu'il fait. C'est ce qui fait la difference sur le taux de
    // declenchement, plus encore que le prompt systeme.
    description:
      "Gere les rondes de surveillance : un circuit que le robot APPREND en se faisant piloter une " +
      "fois, puis rejoue en boucle tout seul avec une pause entre chaque tour. " +
      "Appelle-le pour 'apprends la ronde' / 'retiens ce trajet' (action apprendre_debut), " +
      "'c'est bon, tu connais le tour' (apprendre_fin), 'fais ta ronde' / 'commence a patrouiller' " +
      "(demarrer), 'arrete la ronde' (arreter), 'oublie la ronde' (oublier), " +
      "'ou en est ta ronde' (etat). " +
      "IMPORTANT : apprendre_debut n'enregistre que pendant qu'on pilote le robot ; previens " +
      "l'utilisateur qu'il doit maintenant faire le tour en le conduisant, puis te dire quand c'est fini.",
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['apprendre_debut', 'apprendre_fin', 'demarrer', 'arreter', 'oublier', 'etat'],
          description: "L'operation a effectuer sur la ronde.",
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'suivre_personne',
    description:
      "Mode 'suis-moi' : le robot emboite le pas a la personne devant lui et la suit en gardant " +
      "ses distances, jusqu'a ce qu'on lui dise stop. A utiliser pour 'suis-moi', 'viens avec moi', " +
      "'accompagne-moi'. Rend la main tout de suite : le robot continue de suivre en arriere-plan.",
    input_schema: {
      type: 'object',
      properties: {
        cible: {
          type: 'string',
          description:
            "Qui suivre, decrit visuellement. Par defaut 'la personne devant le robot'. " +
            "Precise s'il y a un detail utile : 'la personne au pull rouge'.",
        },
      },
      required: [],
    },
  },
  {
    name: 'arreter_suivi',
    description:
      "Arrete le mode 'suis-moi' en cours. A utiliser pour 'arrete de me suivre', 'stop', " +
      "'reste la' quand le robot est en train de suivre quelqu'un.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'aller_vers_objet',
    description:
      "Se diriger vers un objet VISIBLE par la camera (une poubelle, une porte, une personne...). " +
      "Le robot avance par petits pas en recentrant l'objet dans son image, jusqu'a l'atteindre. " +
      "A utiliser pour 'va vers...', 'rejoins...', 'approche-toi de...' quand la cible est un objet " +
      "et non une adresse postale.",
    input_schema: {
      type: 'object',
      properties: {
        objet: {
          type: 'string',
          description: "Description courte et visuelle de la cible. Ex: 'la poubelle noire a roulettes'.",
        },
      },
      required: ['objet'],
    },
  },
  {
    name: 'etat_robot',
    description:
      'Renvoie la position GPS du robot, la distance a l obstacle devant lui et l etat de ses moteurs.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'mode_surveillance',
    description:
      "Arme ou desarme la surveillance de la maison. A utiliser quand la personne ANNONCE " +
      "qu'elle part (\"je m'en vais\", \"j'y vais\", \"je pars\", \"a ce soir\") ou qu'elle rentre " +
      "(\"je suis rentre\", \"me revoila\"), et quand elle demande explicitement le mode absent " +
      "ou le mode normal. N'appelle PAS cet outil sur une simple question (\"tu es en mode quoi ?\") " +
      "ni si la personne parle du depart de quelqu'un d'autre.",
    input_schema: {
      type: 'object',
      properties: {
        absent: {
          type: 'boolean',
          description:
            'true = mode ABSENT, la surveillance s arme. false = mode NORMAL, elle se desarme.',
        },
      },
      required: ['absent'],
    },
  },
];

// ============================================================
// Mode hybride : commandes reconnues EN LOCAL (gratuit, instantane)
// ============================================================
// Les ordres courants ("avance", "tourne a droite", "stop"...) sont traites
// ici sans appeler l'API : reponse immediate et zero cout. Tout le reste
// (questions, descriptions, demandes formulees librement) part chez Claude.

// Enleve accents/ponctuation pour comparer sans se soucier de la transcription.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOMBRES = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
  six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, demi: 0.5,
};

// Duree en secondes trouvee dans la phrase ("pendant 3 secondes", "deux
// secondes"). Comprend aussi les nuances parlees ("un peu", "beaucoup").
// Defaut 1s, bornee a 5s comme l'outil de pilotage.
function dureeDe(txt) {
  const chiffre = /(\d+(?:[.,]\d+)?)\s*(?:secondes?|s\b)/.exec(txt);
  if (chiffre) return Math.max(0.2, Math.min(5, parseFloat(chiffre[1].replace(',', '.'))));
  for (const [mot, val] of Object.entries(NOMBRES)) {
    if (new RegExp(`\\b${mot}\\b\\s*(?:secondes?)`).test(txt)) return Math.min(5, val);
  }
  // Nuances courantes : evitent de deranger l'IA pour "avance un peu".
  if (/\b(un peu|un petit peu|legerement|doucement|un chouia|un tout petit peu)\b/.test(txt)) return 0.6;
  if (/\b(beaucoup|longtemps|bien|a fond|loin|tout droit)\b/.test(txt)) return 3;
  return 1;
}

// Renvoie { tool, input, reply } si la phrase est une commande connue, sinon null.
function commandeLocale(texte) {
  const t = normalize(texte);
  if (!t) return null;

  // Surveillance : AVANT l'arret generique, sinon "arrete la surveillance"
  // serait compris comme "arrete-toi" — le mot "arrete" y suffirait.
  //
  // Traite en local, et pas laisse a l'IA : on dit "je m'en vais" les mains
  // pleines, sur le pas de la porte. Cette phrase-la doit partir tout de
  // suite, sans dependre d'un aller-retour reseau qui peut echouer au pire
  // moment. L'IA garde la main sur les tournures moins directes.
  if (/\b(mode absent|active la surveillance|arme la surveillance|surveille la maison)\b/.test(t)
      || /\b(je m en vais|je men vais|je pars|j y vais|je quitte la maison)\b/.test(t)) {
    return { tool: 'mode_surveillance', input: { absent: true }, reply: null };
  }
  if (/\b(mode normal|(arrete|coupe|desactive|desarme) la surveillance)\b/.test(t)
      || /\b(je suis rentre|je suis rentree|je suis revenu|je suis revenue|me revoila)\b/.test(t)) {
    return { tool: 'mode_surveillance', input: { absent: false }, reply: null };
  }

  // Arret : prioritaire, doit marcher meme au milieu d'une phrase.
  if (/\b(stop|stoppe|arrete|arretes|arreter|halte|stoppez)\b/.test(t)) {
    return { tool: 'piloter', input: { action: 'stop' }, reply: 'Stop.' };
  }

  // "Suis-moi" traite en local : c'est une demande frequente, autant qu'elle
  // parte instantanement et gratuitement.
  if (/\b(suis moi|suit moi|suis moi stp|viens avec moi|accompagne moi|suis moi steuplait)\b/.test(t)) {
    return { tool: 'suivre_personne', input: {}, reply: null };
  }
  if (/\b(arrete de me suivre|ne me suis plus|reste la|reste ici)\b/.test(t)) {
    return { tool: 'arreter_suivi', input: {}, reply: null };
  }

  // Etat / position, formes EXPLICITES uniquement. Placees avant le garde-fou
  // ci-dessous parce que ce sont des questions, mais si courantes qu'on prefere
  // y repondre gratuitement.
  if (/\b(ou es tu|ou est tu|ou tu es|ta position|ton etat|ta batterie)\b/.test(t)) {
    return { tool: 'etat_robot', input: {}, reply: null }; // reply = texte du statut
  }

  // GARDE-FOU : une QUESTION n'est jamais une commande de pilotage.
  // Sans lui, le simple mot "droite" dans "qu'est-ce qu'il y a a ma droite ?"
  // faisait TOURNER le robot au lieu de repondre, et Claude n'etait jamais
  // appele — d'ou l'impression que l'assistant ne comprend que les ordres
  // simples. La ponctuation est retiree par normalize(), on teste donc le "?"
  // sur le texte BRUT.
  const estQuestion =
    /\?/.test(String(texte)) ||
    /^(qu|que|quoi|qui|quel|quelle|quels|quelles|ou|comment|pourquoi|combien|est ce que|peux tu|sais tu|vois tu|y a t il|dis moi|decris|raconte|explique|cherche|trouve|regarde)\b/.test(t);
  if (estQuestion) return null;

  // Demi-tour : une rotation longue, avant les autres regles (contient "tour").
  if (/\b(demi tour|fais demi tour|retourne toi|fais un demi tour|volte face)\b/.test(t)) {
    return {
      tool: 'piloter',
      input: { action: 'droite', duree_secondes: 3 },
      reply: 'Demi-tour.',
    };
  }

  const mouvements = [
    { re: /\b(avance|avancer|avances|avancez|tout droit|en avant|va devant|vas y|roule|demarre)\b/, action: 'avancer', mot: 'J avance' },
    { re: /\b(recule|reculer|recules|reculez|en arriere|va derriere|recul)\b/, action: 'reculer', mot: 'Je recule' },
    // Le mot "droite"/"gauche" SEUL n'est plus un declencheur : il apparait
    // dans trop de phrases qui ne sont pas des ordres ("la poubelle est a
    // droite du portail"). Il faut desormais une tournure de commande.
    { re: /\b(a droite|vers la droite|tourne droite|sur la droite|tourne a droite|pivote a droite)\b/, action: 'droite', mot: 'Je tourne a droite' },
    { re: /\b(a gauche|vers la gauche|tourne gauche|sur la gauche|tourne a gauche|pivote a gauche)\b/, action: 'gauche', mot: 'Je tourne a gauche' },
  ];
  for (const m of mouvements) {
    if (m.re.test(t)) {
      const secs = dureeDe(t);
      return {
        tool: 'piloter',
        input: { action: m.action, duree_secondes: secs },
        reply: `${m.mot}.`,
      };
    }
  }

  return null;
}

function getConversation(code) {
  const now = Date.now();
  const existing = conversations.get(code);
  if (existing && now - existing.lastAt < HISTORY_TTL_MS) {
    existing.lastAt = now;
    return existing;
  }
  const fresh = { messages: [], lastAt: now };
  conversations.set(code, fresh);
  return fresh;
}

// --- Transcription ---
// Deux moteurs. Deepgram (cloud) si une cle est fournie : ~1s au lieu de ~10s
// et meilleure precision en francais. Sinon whisper.cpp en local sur le VPS,
// gratuit mais lent (le CPU n'a pas de carte graphique). En cas de pepin
// reseau, on retombe automatiquement sur whisper : le robot reste utilisable.
// Mesures du 30/07 sur une phrase FR (moyenne de 3 essais) :
//   nova-3   1070ms  transcription exacte  <-- retenu
//   nova-2   1240ms  transcription exacte
//   enhanced 1338ms  resultat vide
//   base     1114ms  resultat inexploitable
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';


async function transcribeDeepgram(wavPath, key) {
  const audio = fs.readFileSync(wavPath);
  const url =
    `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(DEEPGRAM_MODEL)}` +
    '&language=fr&smart_format=true&punctuate=true';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
    body: audio,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`deepgram ${res.status} ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  const alt = json?.results?.channels?.[0]?.alternatives?.[0];
  return String(alt?.transcript || '').trim();
}

// Transcription locale par whisper.cpp (aucun envoi a un service tiers).
function transcribeWhisper(wavPath) {
  return new Promise((resolve) => {
    execFile(
      WHISPER_BIN,
      // -bo 1 -bs 1 : decodage direct (pas d'exploration de variantes)
      // -nf         : pas de re-essais a temperature croissante
      //   -> ces deux-la divisent le temps par ~4 sans perte de qualite.
      // --prompt    : amorce en francais. Whisper traduisait parfois en
      //   anglais ("regarde autour de toi" -> "To watch me") ; l'amorce ancre
      //   la langue ET le vocabulaire attendu (les commandes du robot).
      // -sns        : supprime les annotations inventees type "[Bruit de porte]".
      ['-m', WHISPER_MODEL, '-f', wavPath, '-l', 'fr', '-nt', '-np', '--no-prints',
        '-t', '4', '-bo', '1', '-bs', '1', '-nf', '-sns',
        '--prompt', WHISPER_PROMPT],
      { timeout: 90000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve('');
        resolve(String(stdout || '').replace(/\s+/g, ' ').trim());
      }
    );
  });
}

// Aiguillage : Deepgram si dispo, whisper en secours.
async function transcribe(wavPath, log) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (key) {
    try {
      const t0 = Date.now();
      const txt = await transcribeDeepgram(wavPath, key);
      log(`[VOICE] deepgram ${Date.now() - t0}ms`);
      if (txt) return txt;
      log('[VOICE] deepgram: transcription vide, repli sur whisper.');
    } catch (e) {
      log('[VOICE] deepgram indisponible, repli sur whisper :', e.message);
    }
  }
  return transcribeWhisper(wavPath);
}

// Geocodage d'une adresse (Nominatim / OpenStreetMap, gratuit).
async function geocode(adresse) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' +
    encodeURIComponent(adresse);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ping-robot/1.0 (assistant vocal)' },
    signal: AbortSignal.timeout(8000),
  });
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  return {
    latitude: Number(list[0].lat),
    longitude: Number(list[0].lon),
    label: String(list[0].display_name || adresse).split(',').slice(0, 3).join(','),
  };
}

// Attend un event du robot (statut GPS...) avec un delai maximum.
function waitForRobot(io, code, event, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const room = io.sockets.adapter.rooms.get(code);
    if (!room) return resolve(null);

    const listening = [];
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Toujours retirer les ecouteurs : sans ca ils s'accumulaient a chaque
      // question et Node finissait par alerter sur une fuite memoire.
      for (const s of listening) s.off(event, handler);
      resolve(payload);
    };
    const handler = (payload) => finish(payload);
    const timer = setTimeout(() => finish(null), timeoutMs);

    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s) {
        s.on(event, handler);
        listening.push(s);
      }
    }
    if (!listening.length) finish(null);
  });
}

// --- Asservissement visuel : rejoindre un objet vu par la camera ---
// Boucle simple et robuste : on prend une image, on demande OU est l'objet,
// on corrige le cap ou on avance, et on recommence. Un modele rapide suffit
// pour cette tache de reperage (Haiku), le raisonnement reste chez Opus.
const VISION_MODEL = process.env.VISION_MODEL || 'claude-haiku-4-5-20251001';
const SERVO_MAX_STEPS = Number(process.env.SERVO_MAX_STEPS || 10);
const SERVO_MAX_MS = Number(process.env.SERVO_MAX_MS || 60000);

// Client Claude partage, construit a la demande. Les outils de vision
// (aller_vers_objet, suivre_personne) en ont besoin ; or ils sont aussi
// appeles depuis la conversation EN DIRECT (realtime-voix.js), qui n'a pas de
// client Claude a fournir. Elle passait client=null et chaque appel plantait
// aussitot ("Cannot read properties of null") : le robot disait voir la
// poubelle — l'image, elle, lui vient de sa propre vision — puis annoncait que
// la fonction avait plante des qu'on lui demandait d'y aller. Le client est
// donc trouve ici plutot qu'exige de l'appelant.
let clientPartage = null;
function clientVision(log = console.log) {
  if (clientPartage) return clientPartage;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    clientPartage = new Anthropic();
  } catch (e) {
    log('[VISION] SDK Anthropic indisponible :', e.message);
  }
  return clientPartage;
}

// Demande une image fraiche au robot (via ack socket).
function grabFrame(io, code, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const room = io.sockets.adapter.rooms.get(code);
    if (!room) return resolve(null);
    let done = false;
    const finish = (buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(buf && buf.length ? Buffer.from(buf) : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    for (const id of room) {
      const s = io.sockets.sockets.get(id);
      if (s) s.emit('robot_grab_frame', {}, (buf) => { if (buf) finish(buf); });
    }
  });
}

// Que voit-on sur cette image ? Utilise par les alertes de surveillance.
//
// Le radar dit "quelque chose bouge", jamais "quoi". C'est toute la
// difference entre un detecteur et un systeme de surveillance : savoir en
// une seconde si c'est le chat ou quelqu'un, sans ouvrir l'application.
//
// Le modele rapide suffit largement : on demande une description factuelle,
// pas un raisonnement.
async function decrireScene(image, log = console.log) {
  const client = clientVision(log);
  if (!client || !image || !image.length) return null;
  try {
    const res = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 120,
      system:
        "Tu regardes l'image d'une camera de surveillance domestique, prise parce qu'un " +
        'capteur vient de detecter quelque chose. ' +
        'Reponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme : ' +
        '{"categorie":"personne|animal|rien","phrase":"..."} ' +
        'categorie vaut "personne" si un etre humain est visible, "animal" si un animal ' +
        'seul est visible, "rien" si rien de notable ne l\'est. ' +
        'phrase : UNE phrase courte en francais, factuelle, sans dramatiser. Pour un animal, ' +
        "dis lequel. Pour une personne, decris brievement sa position et ses vetements. " +
        'Pour "rien", ecris exactement : Rien de visible. ' +
        "N'annonce JAMAIS une personne dont tu n'es pas sur : dans le doute, choisis " +
        '"animal" ou "rien" et decris ce que tu vois reellement. Se tromper en annoncant ' +
        "un intrus qui n'existe pas rend l'alerte inutile.",
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.toString('base64') } },
          { type: 'text', text: "Que vois-tu ?" },
        ],
      }],
    });
    const t = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (!t) return null;

    // Le modele repond du JSON, mais on ne PARIE pas la-dessus : une alerte ne
    // doit pas se perdre parce qu'une accolade manque. On extrait l'objet s'il
    // est la, sinon on garde le texte brut et on devine la categorie dessus.
    try {
      const brut = t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
      const j = JSON.parse(brut);
      const cat = ['personne', 'animal', 'rien'].includes(j.categorie) ? j.categorie : 'rien';
      const phrase = String(j.phrase || '').trim();
      if (phrase) return { categorie: cat, phrase };
    } catch {
      log('[VISION] reponse non JSON, repli sur le texte brut.');
    }
    const minus = t.toLowerCase();
    const categorie = /personne|homme|femme|individu|quelqu/.test(minus)
      ? 'personne'
      : /rien de visible/.test(minus) ? 'rien' : 'animal';
    return { categorie, phrase: t };
  } catch (e) {
    log('[VISION] description impossible :', e.message);
    return null;
  }
}

// Ou est l'objet dans l'image ? Renvoie {vu, x, taille} :
//   x     : -1 (bord gauche) .. 0 (centre) .. +1 (bord droit)
//   taille: 0 (minuscule, loin) .. 1 (remplit l'image, tout pres)
async function localiserObjet(client, frame, objet) {
  const res = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 300,
    system:
      "Tu analyses l'image d'une camera embarquee sur un robot. Reponds UNIQUEMENT par un objet " +
      'JSON, sans texte autour : {"vu": true|false, "x": nombre entre -1 et 1, "taille": nombre entre 0 et 1}. ' +
      'x = position horizontale du centre de l objet (-1 bord gauche, 0 centre, 1 bord droit). ' +
      'taille = part de la hauteur de l image occupee par l objet (0.05 tres loin, 0.8 tout pres). ' +
      'Si l objet n est pas visible : {"vu": false, "x": 0, "taille": 0}.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } },
        { type: 'text', text: `Ou se trouve : ${objet} ?` },
      ],
    }],
  });
  const txt = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) return { vu: false, x: 0, taille: 0 };
  try {
    const j = JSON.parse(m[0]);
    return {
      vu: !!j.vu,
      x: Math.max(-1, Math.min(1, Number(j.x) || 0)),
      taille: Math.max(0, Math.min(1, Number(j.taille) || 0)),
    };
  } catch {
    return { vu: false, x: 0, taille: 0 };
  }
}

// Envoie un ordre moteur pendant N secondes (en repetant : l'Arduino coupe
// les moteurs au bout de 900 ms sans commande) puis s'arrete.
async function bouger(io, code, cmd, secs, annule) {
  const until = Date.now() + secs * 1000;
  let n = 0;
  while (Date.now() < until) {
    // Un arret d'urgence doit etre pris en compte au milieu d'une impulsion,
    // pas seulement entre deux : une impulsion dure jusqu'a 0,7 s.
    if (annule && annule()) break;
    io.to(code).emit('robot_drive', { cmd, by: 'solana', id: `servo-${Date.now()}-${n++}` });
    await new Promise((r) => setTimeout(r, Math.min(400, Math.max(0, until - Date.now()))));
  }
  io.to(code).emit('robot_drive', { cmd: 'S', by: 'solana', id: `servo-stop-${Date.now()}` });
  await new Promise((r) => setTimeout(r, 400)); // laisse le chassis se stabiliser
}

// --- Vision d'evitement pendant la navigation GPS ---
// Le robot navigue vers un point GPS en ligne droite : il ne connait ni les
// murs ni les obstacles. Son capteur a ultrasons ne voit qu'a 25 cm, droit
// devant. Ici la CAMERA devient un capteur d'obstacle a plusieurs metres :
// on demande au modele si la voie est libre, et on renvoie une distance
// estimee que le robot injecte dans sa logique d'evitement existante.
async function analyserVoie(client, frame, contexte) {
  // Le contexte de navigation (ou est la destination) est determinant : sans
  // lui, le modele choisit un cote au hasard et peut faire contourner du
  // mauvais cote, a l'oppose du but.
  let situation = 'La voie est-elle libre devant moi ?';
  if (contexte && Number.isFinite(contexte.distanceM)) {
    const d = Math.round(contexte.distanceM);
    if (Number.isFinite(contexte.capRelatif)) {
      const ecart = Math.round(contexte.capRelatif);
      const ou =
        Math.abs(ecart) < 20
          ? 'droit devant moi'
          : `a ${Math.abs(ecart)} degres sur ma ${ecart > 0 ? 'droite' : 'gauche'}`;
      situation =
        `Je roule vers ma destination, situee a ${d} metres, ${ou}. ` +
        'La voie est-elle libre ? Si je dois contourner, privilegie le cote qui me rapproche ' +
        'de ma destination, sauf si ce cote est bloque.';
    } else {
      situation = `Je roule vers une destination a ${d} metres. La voie est-elle libre ?`;
    }
  }

  const res = await client.messages.create({
    model: VISION_MODEL,
    max_tokens: 300,
    system:
      "Tu regardes par la camera avant d'un petit robot a roues qui roule vers une destination. " +
      'Evalue si la voie devant lui est degagee. Reponds UNIQUEMENT par un objet JSON : ' +
      '{"libre": true|false, "distance_m": nombre, "cote_libre": "gauche"|"droite"|"aucun"}. ' +
      'libre = le robot peut avancer sans rien heurter dans les 2 prochains metres. ' +
      'distance_m = distance estimee de l obstacle le plus proche DEVANT lui (10 si rien). ' +
      'cote_libre = de quel cote il pourrait contourner, en tenant compte de sa destination. ' +
      'Compte comme obstacles : murs, meubles, vehicules, personnes, poteaux, marches, trous, ' +
      "bordures hautes. Ne compte PAS le sol plat, l'herbe rase, le gravier.",
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } },
        { type: 'text', text: situation },
      ],
    }],
  });
  const txt = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      libre: !!j.libre,
      distanceM: Math.max(0.1, Math.min(10, Number(j.distance_m) || 10)),
      coteLibre: ['gauche', 'droite'].includes(j.cote_libre) ? j.cote_libre : null,
    };
  } catch {
    return null;
  }
}

// --- Mode "suis-moi" ---
// Contrairement a aller_vers_objet, le suivi ne s'arrete pas en arrivant : il
// MAINTIENT une distance et tourne en fond, pour que la conversation reste
// possible pendant que le robot avance. Une seule session par robot.
const suivis = new Map(); // code -> { actif: bool }

// Asservissements visuels en cours (aller_vers_objet), par code robot.
// Sans ce registre, l'arret d'urgence ne pouvait PAS interrompre la boucle :
// elle tourne ICI, sur le VPS, et reenvoie un ordre moteur toutes les 400 ms.
// Le robot s'arretait donc une fraction de seconde, puis repartait.
const servos = new Map(); // code -> { annule: bool }

function arreterSuivi(io, code) {
  const s = suivis.get(code);
  if (!s || !s.actif) return false;
  s.actif = false;
  // Couper le ticker AVANT le stop, sinon il reenverrait aussitot l'ordre en
  // cours et le robot repartirait malgre le "stop".
  if (s.ticker) clearInterval(s.ticker);
  io.to(code).emit('robot_drive', { cmd: 'S', by: 'solana', id: `suivi-stop-${Date.now()}` });
  io.to(code).emit('robot_drive', { cmd: 'V255', by: 'solana', id: `suivi-fast-${Date.now()}` });
  return true;
}

async function suivrePersonne(client, io, code, cible, log) {
  arreterSuivi(io, code); // jamais deux suivis en parallele
  const session = { actif: true };
  suivis.set(code, session);

  // Le robot parle tout seul pendant le suivi (il n'est plus dans le fil de
  // la conversation) : c'est comme ca qu'il previent s'il te perd de vue.
  const dire = (t) => io.to(code).emit('robot_say', { text: t });

  io.to(code).emit('robot_drive', { cmd: 'V170', by: 'solana', id: `suivi-slow-${Date.now()}` });

  // MOUVEMENT CONTINU. Version precedente : une impulsion, puis arret pendant
  // l'analyse de l'image (~3 s) -> le robot avancait par a-coups. Ici un
  // "ticker" repete l'ordre en cours toutes les 400 ms (l'Arduino coupe les
  // moteurs au bout de 900 ms sans commande), pendant que la boucle de vision
  // se contente de CHANGER cet ordre. Les moteurs ne s'arretent jamais entre
  // deux decisions : l'avance est fluide.
  let ordre = 'S';
  const ticker = setInterval(() => {
    if (!session.actif) return;
    io.to(code).emit('robot_drive', { cmd: ordre, by: 'solana', id: `suivi-${Date.now()}` });
  }, 400);
  session.ticker = ticker;

  // Distances exprimees en "taille apparente" de la cible dans l'image :
  //   < 0.22  -> tu t'eloignes, il avance
  //   0.22-0.75 -> il attend (large plage : quand on lance "suis-moi" on est
  //                juste a cote du robot, il ne doit pas reculer pour autant)
  //   > 0.75  -> vraiment colle : il prend un peu de champ
  const LOIN = 0.22;
  const PRES = 0.75;
  // Pendant les 8 premieres secondes, il ne recule JAMAIS : le temps que tu
  // t'ecartes et que tu commences a marcher.
  const PAS_DE_RECUL_AVANT = Date.now() + 8000;
  const debut = Date.now();
  const MAX_MS = Number(process.env.SUIVI_MAX_MS || 300000); // 5 min de securite
  let perdus = 0;
  let dernierSens = 0;

  (async () => {
    while (session.actif && Date.now() - debut < MAX_MS) {
      const frame = await grabFrame(io, code);
      if (!session.actif) break;
      if (!frame) {
        perdus++;
        if (perdus >= 4) { dire("Je n'ai plus d'image, j'arrete de te suivre."); break; }
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      const c = await localiserObjet(client, frame, cible);
      if (!session.actif) break;
      log(`[SUIVI] vu=${c.vu} x=${c.x.toFixed(2)} taille=${c.taille.toFixed(2)}`);

      if (!c.vu) {
        perdus++;
        if (perdus === 3) dire('Je te cherche.');
        if (perdus >= 6) { dire("Je t'ai perdu, j'arrete de te suivre."); break; }
        // Balayage lent du cote ou la cible a disparu.
        ordre = dernierSens > 0 ? 'R' : 'L';
        await new Promise((r) => setTimeout(r, 300));
        ordre = 'S';
        continue;
      }
      perdus = 0;

      // On ne fait que CHANGER l'ordre en cours : le ticker s'occupe de le
      // maintenir, donc le robot ne marque aucun arret entre deux analyses.
      if (Math.abs(c.x) > 0.28) {
        dernierSens = c.x > 0 ? 1 : -1;
        ordre = dernierSens > 0 ? 'R' : 'L';
        // Rotation breve, puis on laisse filer : la prochaine image dira si
        // c'est assez tourne.
        await new Promise((r) => setTimeout(r, Math.min(350, 150 + Math.abs(c.x) * 200)));
        ordre = c.taille < LOIN ? 'F' : 'S';
      } else if (c.taille < LOIN) {
        ordre = 'F'; // tu t'eloignes : il avance, et CONTINUE d'avancer
      } else if (c.taille > PRES && Date.now() > PAS_DE_RECUL_AVANT) {
        ordre = 'B';
        await new Promise((r) => setTimeout(r, 400));
        ordre = 'S';
      } else {
        ordre = 'S'; // bonne distance : il patiente
      }
    }
    if (session.actif) dire("J'arrete de te suivre.");
    session.actif = false;
    clearInterval(ticker);
    io.to(code).emit('robot_drive', { cmd: 'S', by: 'solana', id: `suivi-fin-${Date.now()}` });
    io.to(code).emit('robot_drive', { cmd: 'V255', by: 'solana', id: `suivi-fin2-${Date.now()}` });
    log('[SUIVI] termine');
  })().catch((e) => {
    log('[SUIVI] erreur', e.message);
    session.actif = false;
    clearInterval(ticker);
    io.to(code).emit('robot_drive', { cmd: 'S', by: 'solana', id: `suivi-err-${Date.now()}` });
  });

  return 'Je te suis. Dis stop quand tu veux que j arrete.';
}

async function allerVersObjet(client, io, code, objet, log) {
  // Une seule manoeuvre a la fois par robot, et elle doit rester joignable
  // depuis l'exterieur (arret d'urgence) — d'ou le registre.
  const session = { annule: false };
  servos.set(code, session);
  const stoppe = () => session.annule;
  const debut = Date.now();
  // Tolerance large : mieux vaut avancer legerement de travers (et corriger au
  // pas suivant) que pivoter sans fin sans jamais progresser.
  const CENTRE_TOL = 0.3;
  const ARRIVE = 0.55; // taille a partir de laquelle on est arrive
  let perdus = 0;
  let dernierSens = 0; // -1 gauche, +1 droite : pour repartir du bon cote
  let gain = 1; // divise par 2 a chaque depassement (anti-oscillation)

  // Vitesse reduite pendant la manoeuvre : a pleine puissance le chassis
  // pivote tellement vite qu'il depassait la cible a chaque correction
  // (mesure : de x=-0.70 a x=+0.85 en une seule impulsion).
  io.to(code).emit('robot_drive', { cmd: 'V150', by: 'solana', id: `servo-slow-${Date.now()}` });
  await new Promise((r) => setTimeout(r, 250));

  const finir = (msg) => {
    if (servos.get(code) === session) servos.delete(code);
    // Toujours rendre sa vitesse normale au robot en repartant.
    io.to(code).emit('robot_drive', { cmd: 'V255', by: 'solana', id: `servo-fast-${Date.now()}` });
    return msg;
  };

  for (let step = 1; step <= SERVO_MAX_STEPS; step++) {
    if (session.annule) return finir('Arret demande, je me suis arrete en chemin.');
    if (Date.now() - debut > SERVO_MAX_MS) {
      return finir(`Temps ecoule apres ${step - 1} manoeuvres, je me suis arrete en chemin.`);
    }
    const frame = await grabFrame(io, code);
    if (!frame) return finir("Je n'arrive pas a prendre d'image, je ne peux pas m'y rendre.");

    const cible = await localiserObjet(client, frame, objet);
    log(`[SERVO] etape ${step}: vu=${cible.vu} x=${cible.x.toFixed(2)} taille=${cible.taille.toFixed(2)} gain=${gain.toFixed(2)}`);

    if (!cible.vu) {
      perdus++;
      if (perdus >= 3) return finir(`Je ne vois plus ${objet}, j'arrete la.`);
      // On repart dans le sens ou l'objet a ete vu la derniere fois (avant, on
      // tournait toujours a droite, ce qui l'eloignait une fois sur deux).
      await bouger(io, code, dernierSens > 0 ? 'R' : 'L', 0.25, stoppe);
      continue;
    }
    perdus = 0;

    if (cible.taille >= ARRIVE) {
      return finir(`J'y suis, ${objet} est juste devant moi (${step} manoeuvres).`);
    }

    if (Math.abs(cible.x) > CENTRE_TOL) {
      const sens = cible.x > 0 ? 1 : -1;
      // Depassement detecte (l'objet est passe de l'autre cote) : on reduit
      // fortement l'amplitude, comme on affine un reglage.
      if (dernierSens !== 0 && sens !== dernierSens) gain = Math.max(0.25, gain * 0.5);
      dernierSens = sens;
      // Impulsions courtes : 0.10 a 0.28 s au lieu de 0.25 a 0.70 s.
      const duree = Math.min(0.28, (0.1 + Math.abs(cible.x) * 0.18) * gain);
      await bouger(io, code, sens > 0 ? 'R' : 'L', duree, stoppe);
    } else {
      // Suffisamment centre : on avance (c'est le but), prudemment si proche.
      await bouger(io, code, 'F', cible.taille > 0.35 ? 0.4 : 0.7, stoppe);
    }
  }
  return finir(`Je me suis approche de ${objet}, mais je ne suis pas encore tout contre.`);
}

// Arret d'urgence : coupe tout ce que le SERVEUR pilote de lui-meme.
//
// Le bouton de l'app envoie deja un "stop" au robot, mais cela ne suffit pas :
// le suivi de personne et "va vers la poubelle" sont des boucles qui tournent
// sur le VPS et qui reenvoient un ordre moteur 400 ms plus tard. Il faut les
// eteindre a la source, sinon le robot repart tout seul apres l'arret.
function toutArreter(io, code, log = console.log) {
  const servo = servos.get(code);
  if (servo) servo.annule = true;
  const suivi = arreterSuivi(io, code);
  io.to(code).emit('robot_drive', { cmd: 'S', by: 'arret-urgence', id: `stopall-${Date.now()}` });
  // L'asservissement visuel avait ralenti le chassis (V150) : on lui rend sa
  // vitesse, sinon il resterait mou au prochain ordre manuel.
  io.to(code).emit('robot_drive', { cmd: 'V255', by: 'arret-urgence', id: `stopall-v-${Date.now()}` });
  log(`[STOP] arret d'urgence code=${code} (manoeuvre=${!!servo}, suivi=${suivi})`);
  return { servo: !!servo, suivi };
}

// Execute un outil demande par Claude et renvoie le contenu du tool_result.
async function runTool(name, input, ctx) {
  const { io, code, frame, log } = ctx;
  // Repli sur le client partage : la conversation en direct n'en fournit pas.
  const client = ctx.client || clientVision(log);

  if (name === 'mode_surveillance') {
    const absent = !!input?.absent;
    // Le robot garde ce mode sur son disque et le confirme par
    // robot_mode_status : l'app met son selecteur a jour toute seule, meme si
    // c'est la voix qui a decide.
    io.to(code).emit('robot_mode', { absent });
    log(`[VOICE] mode de surveillance -> ${absent ? 'ABSENT' : 'NORMAL'}`);
    return [{
      type: 'text',
      text: absent
        ? "Mode absence active. La surveillance s'arme dans trente secondes, le temps que tu sortes. Bonne journee."
        : 'Mode normal. La surveillance est desarmee, je ne guette plus.',
    }];
  }

  if (name === 'piloter') {
    const map = { avancer: 'F', reculer: 'B', gauche: 'L', droite: 'R', stop: 'S' };
    const cmd = map[input?.action];
    if (!cmd) return [{ type: 'text', text: 'Action inconnue.' }];
    if (cmd === 'S') {
      // "Stop" coupe AUSSI un suivi en cours : sans ca le robot s'arreterait
      // une fraction de seconde puis repartirait aussitot de lui-meme.
      const suivait = arreterSuivi(io, code);
      io.to(code).emit('robot_drive', { cmd, by: 'solana', id: `voice-${Date.now()}` });
      return [{ type: 'text', text: suivait ? 'Robot arrete, je ne te suis plus.' : 'Robot arrete.' }];
    }
    // Toute autre commande manuelle interrompt aussi le suivi automatique.
    arreterSuivi(io, code);
    // Duree bornee : securite (le robot roule vraiment).
    const secs = Math.max(0.2, Math.min(5, Number(input?.duree_secondes) || 1));
    // Le mouvement part EN FOND : on rend la main tout de suite pour que le
    // robot puisse repondre pendant qu'il roule (avant, il attendait la fin du
    // mouvement avant de parler, soit 1 a 5 s perdues a chaque ordre).
    // L'Arduino coupe les moteurs si aucune commande n'arrive pendant 900 ms
    // (SAFE_STOP) : on repete donc l'ordre toutes les 400 ms — c'est aussi la
    // meilleure des securites, un lien coupe = arret en moins d'une seconde.
    (async () => {
      const HOLD_MS = 400;
      const until = Date.now() + secs * 1000;
      let n = 0;
      while (Date.now() < until) {
        io.to(code).emit('robot_drive', { cmd, by: 'solana', id: `voice-${Date.now()}-${n++}` });
        await new Promise((r) => setTimeout(r, Math.min(HOLD_MS, Math.max(0, until - Date.now()))));
      }
      io.to(code).emit('robot_drive', { cmd: 'S', by: 'solana', id: `voice-stop-${Date.now()}` });
    })().catch(() => {});
    log(`[VOICE] piloter ${input.action} ${secs}s`);
    return [{ type: 'text', text: `Mouvement "${input.action}" effectue pendant ${secs}s, robot arrete.` }];
  }

  if (name === 'regarder') {
    if (!frame || !frame.length) {
      return [{ type: 'text', text: "Pas d'image : la camera du robot est eteinte." }];
    }
    // L'image n'entre dans le contexte de Claude QUE si l'outil est appele :
    // le robot l'envoie a chaque question (gratuit), on ne la facture que si utile.
    return [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.toString('base64') } },
      { type: 'text', text: 'Image en direct de la camera du robot.' },
    ];
  }

  if (name === 'aller_a') {
    const adresse = String(input?.adresse || '').trim();
    if (!adresse) return [{ type: 'text', text: 'Adresse manquante.' }];
    let pos = null;
    try {
      pos = await geocode(adresse);
    } catch {}
    if (!pos) return [{ type: 'text', text: `Adresse introuvable : ${adresse}.` }];
    io.to(code).emit('robot_nav', {
      target: { latitude: pos.latitude, longitude: pos.longitude },
      on: true,
    });
    log(`[VOICE] aller_a ${pos.label} (${pos.latitude},${pos.longitude})`);
    return [{ type: 'text', text: `Navigation lancee vers ${pos.label}.` }];
  }

  if (name === 'bouger_camera') {
    const direction = String(input?.direction || '').trim();
    const amplitude = String(input?.amplitude || 'moyen').trim();
    // Le robot raisonne en angles, l'IA en langage courant : la conversion se
    // fait ici. Les valeurs restent modestes — mieux vaut deux petits pas avec
    // une photo entre les deux qu'un grand balayage a l'aveugle.
    const pas = { peu: 12, moyen: 28, beaucoup: 50 }[amplitude] ?? 28;
    if (direction === 'centre') {
      io.to(code).emit('robot_cam_move', { id: `voix-${Date.now()}`, center: true });
      log('[VOICE] camera recentree');
      return [{ type: 'text', text: 'Camera recentree.' }];
    }
    const deltas = {
      gauche: { panDelta: pas },
      droite: { panDelta: -pas },
      haut: { tiltDelta: pas },
      bas: { tiltDelta: -pas },
    };
    if (!deltas[direction]) {
      return [{ type: 'text', text: `Direction inconnue : ${direction}.` }];
    }
    io.to(code).emit('robot_cam_move', { id: `voix-${Date.now()}`, ...deltas[direction] });
    log(`[VOICE] camera ${direction} (${pas} deg)`);
    // Laisse le servo finir sa course avant qu'un eventuel "regarder" ne
    // declenche une photo : sinon l'image est prise pendant le mouvement.
    await new Promise((r) => setTimeout(r, 700));
    return [{ type: 'text', text: `Tete tournee vers ${direction}.` }];
  }

  if (name === 'ronde') {
    const action = String(input?.action || '').trim();
    const connues = ['apprendre_debut', 'apprendre_fin', 'demarrer', 'arreter', 'oublier', 'etat'];
    if (!connues.includes(action)) {
      return [{ type: 'text', text: `Action de ronde inconnue : ${action}.` }];
    }
    io.to(code).emit('robot_ronde', { action });
    log(`[VOICE] ronde ${action}`);
    // Le robot repond par un evenement separe (robot_ronde_status) que ce
    // canal ne lit pas : on decrit donc l'action lancee, sans inventer un
    // resultat qu'on n'a pas encore. L'utilisateur verra l'etat dans l'app.
    const phrases = {
      apprendre_debut:
        "Apprentissage lance. Conduis-moi sur le tour complet, puis dis-moi quand c'est termine.",
      apprendre_fin: 'Tour enregistre.',
      demarrer: 'Je commence ma ronde.',
      arreter: 'Ronde arretee.',
      oublier: 'Circuit efface.',
      etat: 'Je regarde ou en est ma ronde.',
    };
    return [{ type: 'text', text: phrases[action] }];
  }

  if (name === 'suivre_personne') {
    const cible = String(input?.cible || '').trim() || 'la personne devant le robot';
    // Sans vision, le suivi ne peut pas fonctionner : on le dit clairement
    // plutot que de partir et de planter au premier coup d'oeil.
    if (!client) return [{ type: 'text', text: "Je ne peux pas te suivre : ma vision n'est pas disponible." }];
    log(`[SUIVI] demarrage, cible="${cible}"`);
    const msg = await suivrePersonne(client, io, code, cible, log);
    return [{ type: 'text', text: msg }];
  }

  if (name === 'arreter_suivi') {
    const stoppe = arreterSuivi(io, code);
    return [{ type: 'text', text: stoppe ? 'Suivi arrete.' : "Je n'etais pas en train de suivre." }];
  }

  if (name === 'aller_vers_objet') {
    const objet = String(input?.objet || '').trim();
    if (!objet) return [{ type: 'text', text: 'Cible non precisee.' }];
    if (!client) return [{ type: 'text', text: "Je ne peux pas m'y rendre : ma vision n'est pas disponible." }];
    log(`[SERVO] cap sur "${objet}"`);
    const bilan = await allerVersObjet(client, io, code, objet, log);
    return [{ type: 'text', text: bilan }];
  }

  if (name === 'etat_robot') {
    io.to(code).emit('robot_status_request', { by: 'solana' });
    const raw = await waitForRobot(io, code, 'robot_status', 5000);
    if (!raw) return [{ type: 'text', text: 'Le robot n a pas repondu.' }];
    // Le robot emet { code, status: {...} } ; le serveur, lui, rediffuse le
    // contenu a plat. On accepte les deux formes (sinon tout paraissait vide
    // et l'assistant annoncait a tort "moteurs deconnectes, pas de GPS").
    const st = raw.status && typeof raw.status === 'object' ? raw.status : raw;
    const parts = [];
    if (st.coords && Number.isFinite(st.coords.latitude)) {
      parts.push(`position ${st.coords.latitude.toFixed(5)}, ${st.coords.longitude.toFixed(5)}`);
      if (Number.isFinite(st.gpsAgeMs)) {
        parts.push(`relevee il y a ${Math.round(st.gpsAgeMs / 1000)} secondes`);
      }
    } else {
      parts.push('pas encore de position GPS (le recepteur cherche les satellites)');
    }
    if (st.obstacleCm != null) parts.push(`obstacle a ${st.obstacleCm} cm`);
    parts.push(st.arduinoConnected ? 'moteurs connectes et prets' : 'moteurs deconnectes');
    if (st.navActive) parts.push('navigation en cours');
    return [{ type: 'text', text: parts.join(', ') + '.' }];
  }

  return [{ type: 'text', text: 'Outil inconnu.' }];
}

// Mode rapide (VOICE_FAST=true) : MEME modele, meme qualite, jusqu'a 2,5x plus
// vite en generation. Tarif double ($10/$50 le million au lieu de $5/$25) —
// negligeable ici, les reponses font deux phrases. Reserve a Opus 5 / Opus 4.8
// et a l'API Claude directe ; sur tout autre modele on l'ignore silencieusement
// plutot que de faire echouer chaque question.
const FAST_MODELS = ['claude-opus-5', 'claude-opus-4-8'];
// Lu A CHAQUE APPEL, et non fige au chargement du module : le fichier .env est
// lu plus tard, dans attachVoiceBrain(). Une constante de haut niveau aurait
// toujours valu false pour un VOICE_FAST venant du .env.
function fastEnabled() {
  return (
    String(process.env.VOICE_FAST || '').toLowerCase() === 'true' &&
    FAST_MODELS.includes(MODEL)
  );
}

// Un seul point d'entree pour l'appel au modele : ajoute le mode rapide quand
// il est actif, et retombe en vitesse normale si ses quotas sont satures.
async function createMessage(client, params, log) {
  if (!fastEnabled()) return client.messages.create(params);
  try {
    return await client.beta.messages.create({
      ...params,
      speed: 'fast',
      betas: ['fast-mode-2026-02-01'],
    });
  } catch (e) {
    // Repli sur TOUTE erreur, pas seulement sur un 429. Le mode rapide est une
    // preversion : selon l'organisation ou la version du SDK, il peut repondre
    // 400 ou 403 — et une premiere version qui ne rattrapait que le 429 faisait
    // alors echouer CHAQUE phrase. Un accelerateur optionnel ne doit jamais
    // pouvoir casser la fonction qu'il accelere.
    // Si l'erreur est reelle (cle invalide, service indisponible), la tentative
    // en vitesse normale echouera a son tour et l'erreur remontera normalement.
    log(`[VOICE] mode rapide indisponible (${e && e.status ? e.status : '?'} ${e && e.message ? e.message.slice(0, 120) : e}) -> repli en vitesse normale.`);
    return client.messages.create(params);
  }
}

// Boucle d'agent : Claude peut enchainer plusieurs outils avant de repondre.
async function askClaude(client, conv, ctx) {
  const log = (ctx && ctx.log) || console.log;
  for (let step = 0; step < 6; step++) {
    const response = await createMessage(client, {
      model: MODEL,
      max_tokens: 4000,
      // Cache du prefixe : les outils sont rendus AVANT le prompt systeme, donc
      // ce seul point de coupe met en cache les deux. Ils ne changent jamais
      // d'un tour a l'autre — sans cela ils etaient re-traites a chaque phrase,
      // ce qui retarde le premier mot de la reponse.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      output_config: { effort: EFFORT },
      tools: TOOLS,
      messages: conv.messages,
    }, log);

    if (response.stop_reason === 'refusal') {
      return "Desole, je prefere ne pas repondre a ca.";
    }

    conv.messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
    }

    const results = [];
    for (const tu of toolUses) {
      let content;
      try {
        content = await runTool(tu.name, tu.input, ctx);
      } catch (e) {
        content = [{ type: 'text', text: `Erreur outil : ${e.message}` }];
      }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    conv.messages.push({ role: 'user', content: results });
  }
  return "Je n'ai pas reussi a terminer cette action.";
}

/**
 * Branche l'assistant vocal sur le serveur socket.io.
 * @param {import('socket.io').Server} io
 * @param {(...args:any[]) => void} log
 */
function attachVoiceBrain(io, log = console.log) {
  let client = null;
  try {
    // Cle API : variable d'environnement, ou fichier .env a cote du serveur
    // (permet de la deposer sans la faire transiter ailleurs).
    try {
      const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
      // Liste EXPLICITE : tout nom absent d'ici est ignore en silence, meme
      // correctement ecrit dans le fichier. Pense a l'ajouter quand tu
      // introduis un nouveau reglage.
      for (const name of [
        'ANTHROPIC_API_KEY',
        'DEEPGRAM_API_KEY',
        'OPENAI_API_KEY',
        'VOICE_FAST',
        'REALTIME_MODEL',
        'REALTIME_VOICE',
        'TELEGRAM_TOKEN',
        'TELEGRAM_CHAT_ID',
        // Appel telephonique sur personne vue (appel-alerte.js).
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
        'TWILIO_FROM',
        'ALERTE_APPEL_NUMERO',
        'ALERTE_APPEL_CADENCE_MS',
      ]) {
        if (process.env[name]) continue;
        const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, 'm').exec(envFile);
        if (m) process.env[name] = m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch {}
    // Passe par le client partage : les outils appeles hors de ce canal (la
    // conversation en direct) reutilisent alors exactement le meme.
    client = clientVision(log);
  } catch (e) {
    log('[VOICE] SDK Anthropic indisponible :', e.message);
  }
  // Sans cle API, l'assistant reste utilisable : les commandes simples
  // ("avance", "tourne a droite", "stop", "ou es-tu") sont traitees en local,
  // gratuitement. Seules les phrases libres ont besoin de Claude.
  const moteurStt = process.env.DEEPGRAM_API_KEY
    ? `Deepgram ${DEEPGRAM_MODEL} (rapide)`
    : 'whisper local (lent)';
  const vitesse = fastEnabled()
    ? 'mode RAPIDE (tarif double)'
    : String(process.env.VOICE_FAST || '').toLowerCase() === 'true'
      ? `mode rapide demande mais indisponible sur ${MODEL} -> vitesse normale`
      : 'vitesse normale';
  if (client) {
    log(
      `[VOICE] Assistant vocal actif : STT ${moteurStt} + Claude ${MODEL} ` +
        `(effort ${EFFORT}, ${vitesse}).`
    );
  }
  else log(`[VOICE] Assistant vocal en mode COMMANDES LOCALES (STT ${moteurStt}, pas de cle Claude).`);

  io.on('connection', (socket) => {
    // Le robot demande "la voie est-elle libre ?" pendant sa navigation GPS.
    // Il envoie une image, on lui renvoie une distance exploitable par sa
    // logique d'evitement (la meme que celle du capteur a ultrasons).
    socket.on('vision_obstacle', async ({ frame, nav }, ack) => {
      if (typeof ack !== 'function') return;
      if (!client || !frame) return ack(null);
      try {
        const vue = await analyserVoie(client, Buffer.from(frame), nav);
        if (!vue) return ack(null);
        log(`[VISION] libre=${vue.libre} distance=${vue.distanceM}m cote_libre=${vue.coteLibre || '-'}`);
        ack({
          libre: vue.libre,
          distanceCm: Math.round(vue.distanceM * 100),
          coteLibre: vue.coteLibre,
        });
      } catch (e) {
        log('[VISION] erreur :', e.message);
        ack(null);
      }
    });

    // Le robot envoie : { code, audio: <Buffer wav 16k mono>, frame: <Buffer jpeg|null> }
    // et attend en retour le texte a prononcer.
    socket.on('voice_ask', async ({ code, audio, frame }, ack) => {
      const reply = (payload) => {
        if (typeof ack === 'function') ack(payload);
      };
      if (!code || !audio) return reply({ error: 'requete invalide' });

      const tmp = path.join(os.tmpdir(), `voice-${code}-${Date.now()}.wav`);
      try {
        fs.writeFileSync(tmp, Buffer.from(audio));
        const started = Date.now();
        const texte = await transcribe(tmp, log);
        log(`[VOICE] code=${code} transcription (${Date.now() - started}ms): "${texte}"`);
        if (!texte || texte.length < 2) {
          return reply({ text: "Je n'ai pas compris.", heard: texte });
        }

        const frameBufEarly = frame ? Buffer.from(frame) : null;

        // 1) Commande simple ? -> traitee ici, gratuitement, sans appeler l'API.
        const cmd = commandeLocale(texte);
        if (cmd) {
          const out = await runTool(cmd.tool, cmd.input, {
            io, code, frame: frameBufEarly, log, client,
          });
          const outText = out.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
          const spoken = cmd.reply || outText;
          log(`[VOICE] code=${code} commande locale "${texte}" -> ${cmd.tool} (gratuit)`);
          return reply({ text: spoken, heard: texte, local: true });
        }

        // 2) Sinon : le cerveau Claude (payant, mais il comprend tout).
        if (!client) {
          // Journaliser IMPERATIVEMENT : sans cette ligne, une phrase libre
          // disparaissait sans laisser de trace — ni commande locale, ni
          // reponse, ni erreur. On croyait a un probleme de routage ou de
          // credits alors que la cle API n'etait tout simplement pas chargee.
          log(
            `[VOICE] code=${code} PAS DE CLIENT CLAUDE (ANTHROPIC_API_KEY absente ` +
              `de ${path.join(__dirname, '.env')} ?) -> reponse "commandes simples" pour "${texte}"`
          );
          return reply({
            text: "Je ne comprends que les commandes simples pour le moment.",
            heard: texte,
          });
        }

        const conv = getConversation(code);
        conv.messages.push({ role: 'user', content: [{ type: 'text', text: texte }] });
        // Fenetre glissante : on garde les derniers echanges seulement.
        if (conv.messages.length > MAX_TURNS * 2) {
          conv.messages = conv.messages.slice(-MAX_TURNS * 2);
          // Ne jamais commencer par un tool_result orphelin.
          while (
            conv.messages.length &&
            (conv.messages[0].role !== 'user' ||
              (Array.isArray(conv.messages[0].content) &&
                conv.messages[0].content.some((b) => b.type === 'tool_result')))
          ) {
            conv.messages.shift();
          }
        }

        const frameBuf = frame ? Buffer.from(frame) : null;
        const text = await askClaude(client, conv, { io, code, frame: frameBuf, log, client });
        log(`[VOICE] code=${code} reponse (${Date.now() - started}ms): "${text}"`);
        reply({ text, heard: texte });
      } catch (e) {
        log('[VOICE] erreur :', e.message);
        // Message parlant selon la cause (credits epuises = cas le plus courant).
        const msg = /credit balance/i.test(e.message)
          ? "Je n ai plus de credits pour reflechir, mais je comprends toujours les commandes simples."
          : 'Desole, une erreur est survenue.';
        reply({ error: e.message, text: msg });
      } finally {
        fs.unlink(tmp, () => {});
      }
    });
  });
}

// commandeLocale est exporte pour pouvoir tester la reconnaissance sans micro.
// TOOLS, SYSTEM_PROMPT et runTool sont exposes pour le mode temps reel
// (realtime-voix.js) : il reutilise EXACTEMENT les memes implementations
// d'outils et la meme personnalite, seule la couche de dialogue change.
// Deux copies divergeraient au premier ajout d'outil.
module.exports = { attachVoiceBrain, commandeLocale, TOOLS, SYSTEM_PROMPT, runTool, toutArreter, decrireScene };
