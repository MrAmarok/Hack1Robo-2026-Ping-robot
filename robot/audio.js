// audio.js - Capture du micro de la webcam (ALSA) en MP3 via ffmpeg, et
// envoi en flux continu (POST chunked) vers le serveur, facon "webradio".
// Le serveur re-diffuse ce flux aux apps qui ecoutent (GET /robot-audio).
//
// Pi 3 friendly : encodage MP3 mono basse qualite = tres peu de CPU/data.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const { URL } = require('url');

class Audio {
  constructor({ device, serverUrl, code, sampleRate, bitrate, log } = {}) {
    // Identifiant stable de la Webcam ML. Le numero de carte ALSA change
    // suivant l'ordre de branchement des deux webcams et peut sinon designer
    // par erreur le micro de l'Innomaker.
    this.device = device || "plug:'dsnoop:CARD=ML,DEV=0'";
    this.serverUrl = serverUrl;
    this.code = code;
    this.sampleRate = sampleRate || 22050;
    this.bitrate = bitrate || '40k';
    this.log = log || console.log;
    this.proc = null;
    this.req = null;
    this.streaming = false;
  }

  start() {
    if (this.streaming) return;
    if (!this.serverUrl || !this.code) {
      this.log('Audio: serverUrl/code manquant, flux non demarre.');
      return;
    }
    this.streaming = true;

    let u;
    try {
      u = new URL(`${this.serverUrl}/robot-audio`);
    } catch (e) {
      this.streaming = false;
      this.log('Audio: SERVER_URL invalide', e.message);
      return;
    }
    u.searchParams.set('code', this.code);

    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'audio/mpeg' },
    };

    this.req = http.request(opts, (res) => {
      this.log(`Audio: connexion POST fermee par le serveur (status ${res.statusCode}).`);
      res.resume();
    });
    this.req.on('error', (e) => this.log('Audio: erreur POST', e.message));

    const args = [
      '-loglevel', 'error',
      // Basse latence (version prudente) : pas de mise en tampon a la capture,
      // et chaque paquet encode part immediatement dans le flux.
      '-fflags', 'nobuffer',
      '-f', 'alsa',
      '-i', this.device,
      '-ac', '1',
      '-ar', String(this.sampleRate),
      '-c:a', 'libmp3lame',
      '-b:a', this.bitrate,
      '-f', 'mp3',
      '-flush_packets', '1',
      'pipe:1',
    ];
    this.log(`Audio: ffmpeg micro ${this.device} -> mp3 ${this.bitrate} mono`);
    try {
      this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.streaming = false;
      this.log('Audio: ffmpeg introuvable ?', e.message);
      return;
    }

    this.proc.stdout.pipe(this.req);
    this.proc.stderr.on('data', (d) => this.log('Audio ffmpeg:', String(d).trim()));
    this.proc.on('close', (code) => {
      this.log(`Audio: ffmpeg arrete (code=${code}).`);
      try { if (this.req) this.req.end(); } catch {}
      this.proc = null;
      this.req = null;
      this.streaming = false;
    });
    this.proc.on('error', (e) => {
      this.log('Audio: erreur ffmpeg (installe-le: sudo apt install ffmpeg).', e.message);
      this.streaming = false;
    });
  }

  stop() {
    this.streaming = false;
    if (this.proc) {
      try { this.proc.kill('SIGKILL'); } catch {}
      this.proc = null;
    }
    if (this.req) {
      try { this.req.end(); } catch {}
      this.req = null;
    }
  }
}

module.exports = { Audio };
