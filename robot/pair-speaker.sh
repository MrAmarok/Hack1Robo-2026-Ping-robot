#!/usr/bin/env bash
# pair-speaker.sh — Appaire une enceinte Bluetooth au Raspberry Pi et
# configure le robot pour parler dessus (TTS + talkie-walkie).
#
# À lancer SUR LE PI, depuis le dossier robot/ :
#   chmod +x pair-speaker.sh
#   ./pair-speaker.sh                       # 1) cherche les enceintes autour
#   ./pair-speaker.sh AA:BB:CC:DD:EE:FF     # 2) appaire celle que tu as choisie
#
# Étape 2 : mets l'enceinte en mode appairage (bouton Bluetooth maintenu
# jusqu'au bip / LED qui clignote vite) AVANT de lancer la commande.
set -e

SERVICE=/etc/systemd/system/ping-robot.service
MAC="${1:-}"

# --- Pré-requis : le pont ALSA<->Bluetooth utilisé par le robot ---
ensure_bluealsa() {
  if command -v bluealsa >/dev/null || command -v bluealsad >/dev/null; then return; fi
  echo "→ Installation du pont audio Bluetooth (bluez-alsa)…"
  sudo apt-get update -qq
  # Debian 12/13 : bluez-alsa-utils ; anciennes versions : bluealsa
  sudo apt-get install -y bluez-alsa-utils 2>/dev/null || sudo apt-get install -y bluealsa
  sudo systemctl enable --now bluealsa 2>/dev/null || true
}

sudo systemctl start bluetooth
sudo rfkill unblock bluetooth 2>/dev/null || true
bluetoothctl power on >/dev/null 2>&1 || true

# ---------- Mode 1 : recherche des enceintes ----------
if [ -z "$MAC" ]; then
  echo "Recherche des appareils Bluetooth pendant 20 s…"
  echo "(mets ton enceinte en mode appairage MAINTENANT)"
  bluetoothctl --timeout 20 scan on >/dev/null 2>&1 || true
  echo
  echo "=== Appareils trouvés ==="
  bluetoothctl devices | sed 's/^Device /  /'
  echo
  echo "Relance avec l'adresse de ton enceinte, ex :"
  echo "  ./pair-speaker.sh AA:BB:CC:DD:EE:FF"
  exit 0
fi

# ---------- Mode 2 : appairage + configuration ----------
if ! [[ "$MAC" =~ ^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$ ]]; then
  echo "❌ Adresse invalide : $MAC (format attendu AA:BB:CC:DD:EE:FF)"; exit 1
fi
MAC="${MAC^^}"
ensure_bluealsa

echo "→ Appairage de $MAC …"
bluetoothctl --timeout 12 scan on >/dev/null 2>&1 || true
bluetoothctl pair "$MAC"    || echo "  (déjà appairée ?)"
bluetoothctl trust "$MAC"   >/dev/null   # reconnexion automatique aux prochains démarrages
bluetoothctl connect "$MAC" || { echo "❌ Connexion impossible. L'enceinte est-elle en mode appairage et allumée ?"; exit 1; }
sleep 2

echo "→ Test du son…"
DEV="bluealsa:DEV=$MAC,PROFILE=a2dp"
if command -v espeak-ng >/dev/null; then
  espeak-ng -v fr -w /tmp/test-hp.wav "Enceinte connectée. Le robot peut parler." 2>/dev/null
  aplay -D "$DEV" /tmp/test-hp.wav 2>/dev/null && echo "  ✅ son joué" || echo "  ⚠️ pas de son (voir plus bas)"
else
  speaker-test -D "$DEV" -c 2 -t sine -l 1 >/dev/null 2>&1 && echo "  ✅ son joué" || echo "  ⚠️ pas de son"
fi

echo "→ Enregistrement dans le service du robot…"
if [ -f "$SERVICE" ]; then
  if grep -q '^Environment=SPEAKER_MAC=' "$SERVICE"; then
    sudo sed -i "s|^Environment=SPEAKER_MAC=.*|Environment=SPEAKER_MAC=$MAC|" "$SERVICE"
  else
    sudo sed -i "/^Environment=CODE=/a Environment=SPEAKER_MAC=$MAC" "$SERVICE"
  fi
  sudo systemctl daemon-reload
  sudo systemctl restart ping-robot
  echo "  ✅ service mis à jour et redémarré"
else
  echo "  ⚠️ $SERVICE introuvable — relance install-service.sh avec SPEAKER_MAC=$MAC"
fi

echo
echo "✅ Terminé. Enceinte : $MAC"
echo "   Depuis l'app : écris un message (le robot le dit) ou maintiens le bouton talkie."
echo "   Vérifier :  journalctl -u ping-robot -n 20 | grep TTS"
