// enregistrement.js - Enregistre la vue de la camera du robot dans un fichier.
//
// Pourquoi cote VPS et pas sur le Pi : le robot publie deja son flux, encode
// en H.264, vers MediaMTX. On se contente donc de le RECOPIER dans un fichier
// (-c copy), sans le reencoder. Consequences :
//   - zero charge supplementaire sur le Pi 3, qui encode deja
//   - zero conflit avec la camera : on ne l'ouvre pas, elle est prise
//   - pas un octet de 4G en plus : le flux est deja arrive ici
//   - le fichier atterrit sur une machine avec du vrai debit, facile a
//     recuperer
//
// La qualite obtenue est exactement celle du direct (RTC_BITRATE). Pour de
// belles images, monte ce reglage sur le robot AVANT de filmer.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DOSSIER = process.env.REC_DIR || '/root/enregistrements';
// MediaMTX autorise la lecture sans mot de passe (le chemin contient deja le
// code du robot). On passe par la boucle locale : rien ne sort de la machine.
const RTSP = process.env.REC_RTSP || 'rtsp://127.0.0.1:3002';
// Garde-fou : un enregistrement oublie remplirait le disque du VPS.
const DUREE_MAX_MS = Number(process.env.REC_MAX_MS || 15 * 60 * 1000);

const enCours = new Map(); // code -> { proc, fichier, debut, minuteur }

function horodatage() {
  const d = new Date();
  const deux = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}` +
    `-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`
  );
}

// refuseSiPasPilote : controle d'acces fourni par le serveur. L'enregistrement
// est une commande comme une autre — il vit simplement dans un autre fichier,
// ce qui l'avait fait echapper au verrou pose sur les douze autres.
function attachEnregistrement(io, log = console.log, refuseSiPasPilote = null) {
  try {
    fs.mkdirSync(DOSSIER, { recursive: true });
  } catch (e) {
    log(`[REC] dossier ${DOSSIER} inaccessible : ${e.message}`);
  }

  const etat = (code, extra = {}) => {
    const s = enCours.get(code);
    io.to(code).emit('robot_record_status', {
      actif: !!s,
      fichier: s ? path.basename(s.fichier) : null,
      secondes: s ? Math.round((Date.now() - s.debut) / 1000) : 0,
      ...extra,
    });
  };

  const demarrer = (code) => {
    if (enCours.get(code)) return;
    const fichier = path.join(DOSSIER, `robot-${code}-${horodatage()}.mp4`);
    const proc = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', `${RTSP}/robot-${code}`,
      // Recopie du H.264 tel quel : aucun reencodage, aucune perte.
      '-c', 'copy',
      // mp4 fragmente : le fichier reste lisible meme si le processus est tue
      // brutalement (coupure de courant, redemarrage). Un mp4 classique ne
      // s'ecrit qu'a la fermeture et serait alors inexploitable.
      // default_base_moof, et non 'default_base_is_moof' : le "is" vient de la
      // description de l'option ("Set the default-base-is-moof flag"), pas de son
      // nom. ffmpeg refusait de demarrer et sortait en code 234 sans rien
      // enregistrer.
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', fichier,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const s = { proc, fichier, debut: Date.now(), minuteur: null, err: '' };
    enCours.set(code, s);

    proc.stderr.on('data', (d) => {
      const t = String(d).trim().slice(0, 200);
      if (t) { s.err = t; log(`[REC] code=${code} ffmpeg: ${t}`); }
    });

    proc.on('close', (sortie) => {
      if (enCours.get(code) !== s) return; // un autre enregistrement a pris la place
      clearTimeout(s.minuteur);
      enCours.delete(code);
      let taille = 0;
      try { taille = fs.statSync(fichier).size; } catch {}
      const secondes = Math.round((Date.now() - s.debut) / 1000);
      log(
        `[REC] code=${code} termine : ${path.basename(fichier)} ` +
        `(${secondes}s, ${(taille / 1048576).toFixed(1)} Mo, code=${sortie})`
      );
      // Un fichier vide a PLUSIEURS causes, et les confondre envoie chercher
      // au mauvais endroit : le message accusait la camera eteinte alors qu'un
      // enregistrement arrete au bout d'une seconde donne le meme resultat,
      // camera allumee. On distingue, et quand ffmpeg a parle on le cite.
      if (taille < 1024) {
        try { fs.unlinkSync(fichier); } catch {}
        // L'erreur de ffmpeg PASSE EN PREMIER : c'est un fait, la duree n'est
        // qu'une supposition. En la mettant apres, mon propre message masquait
        // la vraie cause et renvoyait chercher une camera eteinte.
        let raison;
        if (s.err) {
          raison = `Flux illisible : ${s.err.slice(0, 140)}`;
        } else if (secondes < 3) {
          raison = `Enregistrement trop court (${secondes}s) : il faut quelques ` +
            'secondes avant la premiere image complete.';
        } else {
          raison = 'Aucun flux : allume la camera avant d enregistrer.';
        }
        log(`[REC] code=${code} echec : ${raison}`);
        etat(code, { erreur: raison });
      } else {
        etat(code, { termine: path.basename(fichier), mo: +(taille / 1048576).toFixed(1) });
      }
    });

    proc.on('error', (e) => log(`[REC] code=${code} ffmpeg introuvable : ${e.message}`));

    s.minuteur = setTimeout(() => {
      log(`[REC] code=${code} duree maximale atteinte -> arret.`);
      arreter(code);
    }, DUREE_MAX_MS);

    log(`[REC] code=${code} enregistrement demarre -> ${path.basename(fichier)}`);
    etat(code);
  };

  const arreter = (code) => {
    const s = enCours.get(code);
    if (!s) return;
    clearTimeout(s.minuteur);
    // SIGINT et non SIGKILL : ffmpeg doit fermer proprement le conteneur.
    try { s.proc.kill('SIGINT'); } catch {}
    // Filet de securite si ffmpeg s'obstine.
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch {} }, 4000);
  };

  io.on('connection', (socket) => {
    socket.on('robot_record', (p) => {
      if (refuseSiPasPilote && refuseSiPasPilote(socket, 'robot_record')) return;
      const code = p && p.code;
      if (!code) return;
      if (p.on) demarrer(code);
      else arreter(code);
    });

    socket.on('robot_record_query', (p) => {
      if (p && p.code) etat(p.code);
    });
  });

  log(`[REC] Enregistrement video pret (dossier ${DOSSIER}, max ${Math.round(DUREE_MAX_MS / 60000)} min).`);
}

module.exports = { attachEnregistrement };
