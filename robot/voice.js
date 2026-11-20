// voice.js — L'oreille du robot Solana : detection du mot-cle ("alexa").
//
// Le Pi 3 ne fait que le strict minimum (il est petit) :
//   1. openWakeWord ecoute le micro en continu (~1 Mo de modele, tres leger)
//   2. mot-cle detecte -> petit bip -> enregistrement jusqu'au silence
//   3. le clip part au VPS (event 'voice_ask'), avec la derniere image camera
//   4. le VPS repond un texte -> le robot le dit sur son enceinte Bluetooth
//
// L'ecoute est suspendue pendant que le robot parle : sinon il s'entendrait
// lui-meme et se declencherait en boucle.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Script Python d'ecoute (openWakeWord). Ecrit sur disque au demarrage pour
// n'avoir qu'un seul fichier a deployer cote robot.
const LISTENER_PY = `
import sys, numpy as np
from openwakeword.model import Model

# argv[1] = chemin du modele .onnx (ex: hey_jarvis_v0.1.onnx), argv[2] = seuil.
# vad_threshold : l'inference lourde n'est lancee que si de la voix est
# detectee -> divise par ~4 la charge CPU sur le Pi 3 (silence = presque rien).
model = Model(wakeword_model_paths=[sys.argv[1]], vad_threshold=0.5)
CHUNK = 1280  # 80 ms a 16 kHz, la taille attendue par openWakeWord
THRESHOLD = float(sys.argv[2])

while True:
    raw = sys.stdin.buffer.read(CHUNK * 2)
    if not raw or len(raw) < CHUNK * 2:
        break
    audio = np.frombuffer(raw, dtype=np.int16)
    scores = model.predict(audio)
    if scores and max(scores.values()) >= THRESHOLD:
        print("WAKE", flush=True)
        model.reset()  # evite les re-declenchements en rafale
`;

class Voice {
  constructor({
    device,
    wakeModel,
    wakeEnabled,
    threshold,
    recordSeconds,
    silenceSeconds,
    venvPython,
    ack,
    speakDevice,
    micGain,
    micCard,
    micAutoGain,
    log,
    onAsk,
    getFrame,
    speak,
    isSpeaking,
  } = {}) {
    // Signal donne quand le robot entend le mot-cle : 'bip' (rapide), un texte
    // a prononcer ("Oui"), ou '' pour rester muet.
    this.ack = ack === undefined ? 'bip' : ack;
    this.speakDevice = speakDevice || 'default';
    // Gain de capture ALSA exprime en POURCENTAGE : les plages varient selon
    // le modele (0-3328 sur la webcam ML, 0-24 sur l'Innomaker), une valeur
    // absolue n'a donc aucun sens d'une carte a l'autre. 60% donne assez de
    // portee pour ecouter autour du robot ; l'AGC limite les ecarts de niveau.
    this.micGain = micGain === undefined ? '60%' : micGain;
    // Carte designee par son NOM et non son numero : les numeros changent
    // selon l'ordre de branchement (constate le 02/08, la carte 0 est passee
    // de la webcam ML a l'Innomaker apres un simple rebranchement).
    this.micCard = micCard === undefined ? 'ML' : micCard;
    this.micAutoGain = micAutoGain === undefined ? true : !!micAutoGain;
    // Micro partage de la Webcam ML : l'identifiant de carte reste stable
    // meme si l'Innomaker est detectee avant elle au demarrage.
    this.device = device || "plug:'dsnoop:CARD=ML,DEV=0'";
    this.wakeModel = wakeModel || 'hey_jarvis';
    // Ecoute permanente du mot-cle. La couper laisse l'assistant pilotable
    // par le bouton de l'app (trigger) sans faire tourner python,
    // onnxruntime ni la capture micro continue — indispensable sur une
    // machine a 1 Go de RAM.
    this.wakeEnabled = wakeEnabled !== false;
    this.threshold = threshold || 0.5;
    this.recordSeconds = recordSeconds || 8; // duree maxi d'une question
    // Fin de phrase : 0.5s de silence suffit. Plus reactif, au prix d'une
    // coupure possible si tu marques une longue pause au milieu d'une phrase.
    this.silenceSeconds = silenceSeconds || Number(process.env.VOICE_SILENCE_S || 0.5);
    this.venvPython = venvPython || `${os.homedir()}/voice-venv/bin/python`;
    this.log = log || console.log;
    this.onAsk = onAsk || (async () => null); // envoie au VPS, renvoie le texte
    this.getFrame = getFrame || (() => null); // derniere image camera
    this.speak = speak || (() => {}); // fait parler le robot
    this.isSpeaking = isSpeaking || (() => false);

    this.listener = null; // process python
    this.mic = null; // process arecord qui l'alimente
    this.busy = false; // une question est en cours de traitement
    this.running = false;
    this._scriptPath = path.join(os.tmpdir(), 'ping-wake-listener.py');
    this._modelPath = null;
    // Une seule relance programmee a la fois (voir _spawnListener).
    this._restartTimer = null;
    this._restartDelay = 3000;
    this._healthyTimer = null;
  }

  // Retrouve le .onnx du mot-cle dans le venv openWakeWord.
  _findModel() {
    const venvRoot = path.dirname(path.dirname(this.venvPython)); // .../voice-venv
    // Un chemin complet vers un modele a soi est accepte tel quel.
    //
    // Sans ca, seuls les modeles livres avec openWakeWord etaient utilisables
    // (alexa, hey_jarvis, hey_mycroft...), puisqu'on ne fouillait que
    // l'environnement Python. Un mot-cle entraine sur mesure — "Salut Solana"
    // par exemple — n'avait aucun endroit ou se poser.
    if (this.wakeModel.endsWith('.onnx') || this.wakeModel.includes('/')) {
      try {
        if (fs.existsSync(this.wakeModel)) return this.wakeModel;
      } catch {}
      this.log(`Voix: modele "${this.wakeModel}" annonce comme chemin mais absent du disque.`);
      return null;
    }

    const stack = [path.join(venvRoot, 'lib')];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.startsWith(this.wakeModel) && e.name.endsWith('.onnx')) return full;
      }
    }
    return null;
  }

  // Le gain d'usine du micro webcam (+11 dB) sature des qu'on parle pres ou
  // qu'il y a du bruit : le signal ecrete devient inexploitable par le
  // detecteur. On le ramene a un niveau sain a chaque demarrage (le reglage
  // ALSA ne survit pas au redemarrage du Pi).
  _setMicGain() {
    if (!this.micGain) return;
    const { execFile } = require('child_process');
    execFile('amixer', ['-c', String(this.micCard), 'sset', 'Mic', String(this.micGain)], (err) => {
      if (err) this.log('Voix: reglage du gain micro impossible (', err.message, ')');
      else this.log(`Voix: gain micro regle sur ${this.micGain}.`);
    });
    // Beaucoup de webcams UVC exposent ce controle. S'il n'existe pas sur ce
    // modele, on l'ignore simplement et le gain fixe ci-dessus reste actif.
    if (this.micAutoGain) {
      execFile(
        'amixer',
        ['-c', String(this.micCard), 'sset', 'Auto Gain Control', 'on'],
        (err) => {
          if (!err) this.log('Voix: gain automatique du micro active.');
        }
      );
    }
  }

  start() {
    if (this.running) return;
    this._setMicGain();
    if (!this.wakeEnabled) {
      // Pas de detecteur : on se declare actif pour que trigger() reponde,
      // et on ne lance aucun process. Le micro n'est ouvert qu'au moment
      // d'une question, plus en permanence.
      this.running = true;
      this.log('Voix: mot-cle desactive — declenchement par le bouton de l app uniquement.');
      return;
    }
    this._modelPath = this._findModel();
    if (!this._modelPath) {
      this.log(`Voix: modele "${this.wakeModel}" introuvable dans ${this.venvPython} -> assistant vocal inactif.`);
      return;
    }
    this.running = true;
    fs.writeFileSync(this._scriptPath, LISTENER_PY);
    this._spawnListener();
  }

  _spawnListener() {
    if (!this.running) return;
    // arecord (16 kHz mono) -> python openWakeWord. Deux petits process, pas
    // de dependance audio dans Node.
    this.mic = spawn('arecord', [
      '-q', '-D', this.device,
      '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw',
    ]);
    this.listener = spawn(this.venvPython, [this._scriptPath, this._modelPath, String(this.threshold)]);
    this.mic.stdout.pipe(this.listener.stdin);

    this.listener.stdout.on('data', (d) => {
      if (String(d).includes('WAKE')) this._onWake();
    });
    this.listener.stderr.on('data', (d) => {
      const msg = String(d).trim();
      if (msg && !/warn|deprecat/i.test(msg)) this.log('Voix:', msg.slice(0, 200));
    });

    // UNE SEULE relance en vol. Les deux process meurent toujours ensemble
    // (_cleanup tue le survivant), donc les deux 'close' se declenchent a
    // chaque cycle. Sans ce garde-fou, chaque cycle programmait DEUX relances
    // au lieu d'une : 1, 2, 4, 8, 16... toutes les 3 s. Mesure du 03/08 sur le
    // Pi 5, micro absent : 8 Go de RAM avalés en 25 s par des dizaines de
    // python openWakeWord (~200 Mo chacun) -> OOM, machine injoignable.
    const restart = (who) => (code) => {
      if (!this.running || this._restartTimer) return;
      const delay = this._restartDelay;
      // Micro debranche = echec permanent. On espace jusqu'a 30 s au lieu de
      // reveiller onnxruntime toutes les 3 s pour rien ; le delai revient a 3 s
      // des qu'une ecoute tient debout (voir plus bas).
      this._restartDelay = Math.min(delay * 2, 30000);
      this.log(`Voix: ${who} arrete (code=${code}), relance dans ${delay / 1000}s.`);
      this._cleanup();
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this._spawnListener();
      }, delay);
    };
    this.listener.on('close', restart('detecteur'));
    this.mic.on('close', restart('micro'));
    // Une ecoute qui tient 30 s est consideree comme saine : on remet le delai
    // de relance a son minimum pour rester reactif a une vraie coupure.
    this._healthyTimer = setTimeout(() => {
      this._restartDelay = 3000;
    }, 30000);
    this.mic.on('error', (e) => this.log('Voix: micro indisponible', e.message));
    this.listener.on('error', (e) => this.log('Voix: python indisponible', e.message));

    this.log(`Voix: ecoute du mot-cle "${this.wakeModel}" sur ${this.device}.`);
  }

  _cleanup() {
    clearTimeout(this._healthyTimer);
    this._healthyTimer = null;
    for (const p of [this.listener, this.mic]) {
      if (p) {
        try {
          // Detache les handlers AVANT de tuer : sinon le SIGKILL ci-dessous
          // rappelle le 'close' du survivant et relance une seconde fois.
          p.removeAllListeners('close');
          p.kill('SIGKILL');
        } catch {}
      }
    }
    this.listener = null;
    this.mic = null;
  }

  // Declenchement manuel (bouton de l'app) : exactement le meme parcours que
  // le mot-cle. Pratique quand "Alexa" ne passe pas (bruit, distance).
  trigger() {
    if (!this.running) {
      this.log('Voix: assistant inactif, declenchement ignore.');
      return false;
    }
    if (this.busy) return false;
    this._onWake();
    return true;
  }

  async _onWake() {
    // Ignore si on traite deja une question, ou si le robot est en train de
    // parler (il s'entendrait lui-meme).
    if (this.busy || this.isSpeaking()) return;
    this.busy = true;
    this.log('Voix: mot-cle detecte, j ecoute la question.');
    try {
      if (this.ack === 'bip') {
        // Bip : fichier deja pret, joue directement sur l'enceinte. ~0.4s au
        // lieu de ~2s pour une synthese vocale ("Oui").
        await this._playBeep();
      } else if (this.ack) {
        this.speak(this.ack);
        // ATTENDRE que le robot ait FINI de dire "Oui" : l'enceinte Bluetooth
        // a ~1.5s de preroll, un simple delai fixe faisait enregistrer notre
        // propre voix (transcrite en "Oh..."). On suit l'etat reel du TTS.
        const t0 = Date.now();
        while (!this.isSpeaking() && Date.now() - t0 < 3000) {
          await new Promise((r) => setTimeout(r, 100)); // attend le debut
        }
        while (this.isSpeaking() && Date.now() - t0 < 12000) {
          await new Promise((r) => setTimeout(r, 100)); // attend la fin
        }
        await new Promise((r) => setTimeout(r, 250)); // laisse mourir l'echo
      }
      // La photo part MAINTENANT, en parallele de l'enregistrement. Le micro
      // et la camera sont deux peripheriques independants ; la capturer apres
      // coup ajoutait sa duree (~1s quand la camera n'est pas deja en flux) a
      // l'attente de la reponse, pour une image identique.
      const framePromise = this.getFrame().catch(() => null);
      const wav = await this._record();
      if (!wav) {
        this.busy = false;
        return;
      }
      // Bip de fin (grave) : signale que la question est prise en compte et
      // qu'il reflechit. Joue en fond pour ne pas retarder la reponse.
      if (this.ack) this._playBeep(560).catch(() => {});
      const frame = await framePromise;
      const res = await this.onAsk({ audio: wav, frame });
      const text = res && res.text ? String(res.text) : '';
      if (text) this.speak(text);
      else this.log('Voix: aucune reponse du serveur.');
    } catch (e) {
      this.log('Voix: erreur', e.message);
    } finally {
      // Petite pause avant de reprendre l'ecoute (le temps que l'enceinte
      // finisse de parler et que l'echo retombe).
      setTimeout(() => {
        this.busy = false;
      }, 1500);
    }
  }

  // Genere (une seule fois) puis joue un bip sur l'enceinte.
  // 880 Hz = "je t'ecoute", 560 Hz (plus grave) = "c'est note, je reflechis".
  async _playBeep(freq = 880) {
    const f = path.join(os.tmpdir(), `ping-voice-beep-${freq}.wav`);
    if (!fs.existsSync(f) || fs.statSync(f).size < 1000) {
      await new Promise((resolve) => {
        const { execFile } = require('child_process');
        execFile(
          'ffmpeg',
          // 300 ms de silence AVANT le bip : l'enceinte Bluetooth avale
          // toujours le debut d'une lecture (c'est pour ca qu'un bip court
          // etait inaudible). Puis 180 ms de tonalite bien franche.
          ['-y', '-loglevel', 'error', '-f', 'lavfi',
            `-i`, `sine=frequency=${freq}:duration=0.18`,
            '-af', 'volume=1.0,afade=t=out:st=0.14:d=0.04,adelay=300|300',
            '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', f],
          { timeout: 8000 },
          () => resolve()
        );
      });
    }
    await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('aplay', ['-q', '-D', this.speakDevice, f], { timeout: 5000 }, () => resolve());
    });
  }

  // Enregistre la question : s'arrete au silence (fin de phrase) ou au bout de
  // recordSeconds. Le silence est detecte a l'amplitude, en JS, sans dependance.
  _record() {
    return new Promise((resolve) => {
      const chunks = [];
      const rec = spawn('arecord', [
        '-q', '-D', this.device,
        '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw',
      ]);
      let lastLoudAt = Date.now();
      let sawSpeech = false;
      const startedAt = Date.now();
      // Le micro partage (dsnoop) peut restituer un fond de tampon contenant
      // la fin du mot-cle ("Alexa" se retrouvait dans la question). On jette
      // les premieres millisecondes pour ne garder que ce qui suit.
      let skipBytes = Math.round(16000 * 2 * 0.35); // 350 ms a 16 kHz, 16 bits

      const stop = () => {
        try {
          rec.kill('SIGTERM');
        } catch {}
      };

      rec.stdout.on('data', (chunk) => {
        let buf = chunk;
        if (skipBytes > 0) {
          if (buf.length <= skipBytes) {
            skipBytes -= buf.length;
            return;
          }
          buf = buf.subarray(skipBytes);
          skipBytes = 0;
        }
        chunks.push(buf);
        // Amplitude moyenne du bloc (echantillons 16 bits signes).
        let sum = 0;
        const n = Math.floor(buf.length / 2);
        for (let i = 0; i < n; i++) sum += Math.abs(buf.readInt16LE(i * 2));
        const level = n ? sum / n : 0;
        const now = Date.now();
        if (level > 600) {
          // seuil empirique : parole vs bruit de fond
          lastLoudAt = now;
          sawSpeech = true;
        }
        const silentFor = (now - lastLoudAt) / 1000;
        if (sawSpeech && silentFor > this.silenceSeconds) stop();
        if ((now - startedAt) / 1000 > this.recordSeconds) stop();
      });

      rec.on('close', () => {
        const pcm = Buffer.concat(chunks);
        if (!sawSpeech || pcm.length < 16000) {
          this.log('Voix: rien entendu.');
          return resolve(null);
        }
        this.log(`Voix: question enregistree (${(pcm.length / 32000).toFixed(1)}s).`);
        resolve(wavFromPcm(pcm, 16000, 1));
      });
      rec.on('error', () => resolve(null));
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    this._cleanup();
  }
}

// Enrobe du PCM brut dans un entete WAV (whisper attend un vrai fichier wav).
function wavFromPcm(pcm, rate = 16000, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = rate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = { Voice };
