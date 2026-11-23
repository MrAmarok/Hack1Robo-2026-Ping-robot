// env.js - Charge robot/.env dans process.env, sans dependance.
//
// Les secrets (mot de passe MediaMTX, cle robot) et l'adresse du serveur ne
// vivent plus dans le code : ils sont dans robot/.env, ignore par git.
// Modele : robot/.env.example.
//
// Une variable deja definie (ligne de commande, Environment= du service
// systemd) garde la priorite : le fichier ne fait que combler les manques.

'use strict';

const fs = require('fs');
const path = require('path');

function chargerEnv(fichier = path.join(__dirname, '.env')) {
  let texte;
  try {
    texte = fs.readFileSync(fichier, 'utf8');
  } catch {
    return false; // pas de .env : on garde l'environnement tel quel
  }
  for (const ligne of texte.split(/\r?\n/)) {
    const m = ligne.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || ligne.trimStart().startsWith('#')) continue;
    let valeur = m[2];
    const guillemet = valeur[0];
    if ((guillemet === '"' || guillemet === "'") && valeur.endsWith(guillemet) && valeur.length >= 2) {
      valeur = valeur.slice(1, -1);
    } else {
      valeur = valeur.replace(/\s+#.*$/, ''); // commentaire en fin de ligne
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
  return true;
}

module.exports = { chargerEnv };
