#!/usr/bin/env bash
# install-service.sh — Installe le robot Ping en service de démarrage (systemd)
# À lancer SUR LE RASPBERRY PI, depuis le dossier robot/ :
#   chmod +x install-service.sh
#   CODE=123456 ./install-service.sh
#
# Compatible Pi 3/4 ET Pi 5. Le port serie de l'Arduino est detecte
# automatiquement (voir plus bas) : sur Pi 5, /dev/serial0 n'existe pas tant
# que dtparam=uart0=on n'est pas dans /boot/firmware/config.txt.
set -e

# Détection automatique du dossier, de l'utilisateur et de node
DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(whoami)"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
PI_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo inconnu)"

# --- Port serie de l'Arduino -------------------------------------------------
# Pi 3/4 : l'UART GPIO (pins 8/10) est /dev/serial0 -> ttyS0.
# Pi 5   : l'UART GPIO est /dev/ttyAMA0 (le connecteur de debug, lui, est
#          ttyAMA10). Le lien /dev/serial0 n'apparait qu'avec dtparam=uart0=on.
detect_arduino_port() {
  for p in /dev/serial0 /dev/ttyAMA0 /dev/ttyS0; do
    [ -e "$p" ] && { echo "$p"; return; }
  done
  echo /dev/serial0   # rien trouve : on garde la valeur historique
}

# Réglages (surchargeables par variables d'environnement)
CODE="${CODE:?Définis CODE, ex: CODE=123456 ./install-service.sh}"
# Adresse du serveur et secrets (RTC_PASS, ROBOT_KEY) : dans robot/.env, que
# robot.js charge lui-meme. SERVER_URL passe ici en variable reste prioritaire.
SERVER_URL="${SERVER_URL:-}"
if [ -z "$SERVER_URL" ] && ! grep -qE '^[[:space:]]*(export[[:space:]]+)?SERVER_URL=.' "$DIR/.env" 2>/dev/null; then
  echo "❌ SERVER_URL introuvable : copie .env.example en .env et remplis-le" >&2
  echo "   (ou lance : SERVER_URL=http://<serveur>:3000 CODE=... ./install-service.sh)" >&2
  exit 1
fi
# MAC de l'enceinte Bluetooth (vide = sortie audio par defaut). Ex: SPEAKER_MAC=AA:BB:CC:DD:EE:FF
SPEAKER_MAC="${SPEAKER_MAC:-}"
GPS_ENABLE="${GPS_ENABLE:-true}"
GPS_PORT="${GPS_PORT:-/dev/ttyACM0}"
ARDUINO_PORT="${ARDUINO_PORT:-$(detect_arduino_port)}"
# Le micro du robot est celui de l'Innomaker (camera AVANT). On vise la carte
# par son NOM, stable, et non par un numero qui change au rebranchement.
# Verifier le nom avec : cat /proc/asound/cards
AUDIO_CARD="${AUDIO_CARD:-InnomakerU20CAM}"
AUDIO_DEVICE="${AUDIO_DEVICE:-plug:'dsnoop:CARD=InnomakerU20CAM,DEV=0'}"
RTC_AUDIO="${RTC_AUDIO:-true}"
# aplay = buffer ALSA 0.7s, resiste aux micro-coupures Bluetooth (son hache)
TTS_PLAYER="${TTS_PLAYER:-aplay}"
TTS_KEEP_LAST_CLIP="${TTS_KEEP_LAST_CLIP:-true}"
# Les cameras ne sont PAS forcees ici : robot.js utilise par defaut les chemins
# stables /dev/v4l/by-id/... (le modele est dans le nom, il ne bouge jamais).
# Ne surcharge CAMERA_DEVICE / CAMERA_DEVICE_REAR que si tu changes de webcam.
CAMERA_DEVICE="${CAMERA_DEVICE:-}"
CAMERA_DEVICE_REAR="${CAMERA_DEVICE_REAR:-}"
# Ecoute permanente du mot-cle ("alexa"), DESACTIVEE par defaut.
# L'assistant vocal reste entier : il se declenche par le bouton de l'app.
# Ce qu'on economise en le coupant : python + onnxruntime (~200 Mo) et un
# micro ouvert en continu. Sur le Pi 3 du robot (1 Go de RAM, bus USB unique
# partage avec l'Ethernet), c'est ce qui rend l'assistant tenable.
# Mets VOICE_WAKE=true pour retrouver le mains-libres sur une machine qui a
# la RAM pour (Pi 5), a condition que le venv ~/voice-venv soit installe.
VOICE_WAKE="${VOICE_WAKE:-false}"
# Flux video WebRTC. Vides = valeurs par defaut de robot.js (actif).
# ATTENTION en atelier : sans cle 4G, rtcLinkProfile() voit la route partir par
# wlan0 et choisit 1200 kb/s / 20 fps. Ce flux montant sature le WiFi et fait
# TOMBER la session SSH par laquelle tu travailles. Pour une premiere mise en
# service a distance, lance avec RTC_ENABLE=false CAMERA_ENABLE=false, puis
# reactive une fois le robot autonome (ou plafonne avec RTC_BITRATE=400k).
RTC_ENABLE="${RTC_ENABLE:-}"
CAMERA_ENABLE="${CAMERA_ENABLE:-}"
RTC_BITRATE="${RTC_BITRATE:-}"
RTC_FPS="${RTC_FPS:-}"

echo "Modele       : $PI_MODEL"
echo "Dossier      : $DIR"
echo "Utilisateur  : $USER_NAME"
echo "Node         : $NODE_BIN ($($NODE_BIN -v 2>/dev/null || echo absent), $(uname -m))"
echo "Arduino      : $ARDUINO_PORT"
echo "CODE         : $CODE"

if [ ! -e "$ARDUINO_PORT" ]; then
  echo "⚠️  $ARDUINO_PORT n'existe pas."
  case "$PI_MODEL" in
    *"Pi 5"*)
      echo "   Pi 5 : ajoute 'dtparam=uart0=on' dans /boot/firmware/config.txt puis reboot."
      echo "   (verifie ensuite : ls -l /dev/serial* /dev/ttyAMA*)" ;;
    *)
      echo "   Active l'UART : sudo raspi-config > Interface Options > Serial Port" ;;
  esac
fi

SERVICE=/etc/systemd/system/ping-robot.service

{
  cat <<EOF
[Unit]
Description=Robot Ping (Raspberry Pi)
# Pas d'attente de network-online.target (bloque avec une cle 4G).
# Le robot se reconnecte tout seul (reconnection: Infinity).
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
User=$USER_NAME
Environment=CODE=$CODE
Environment=SPEAKER_MAC=$SPEAKER_MAC
Environment=GPS_ENABLE=$GPS_ENABLE
Environment=GPS_PORT=$GPS_PORT
Environment=ARDUINO_PORT=$ARDUINO_PORT
Environment=AUDIO_CARD=$AUDIO_CARD
Environment="AUDIO_DEVICE=$AUDIO_DEVICE"
Environment=RTC_AUDIO=$RTC_AUDIO
Environment=TTS_PLAYER=$TTS_PLAYER
Environment=TTS_KEEP_LAST_CLIP=$TTS_KEEP_LAST_CLIP
EOF
  [ -n "$SERVER_URL" ]         && echo "Environment=SERVER_URL=$SERVER_URL"
  [ -n "$CAMERA_DEVICE" ]      && echo "Environment=CAMERA_DEVICE=$CAMERA_DEVICE"
  [ -n "$CAMERA_DEVICE_REAR" ] && echo "Environment=CAMERA_DEVICE_REAR=$CAMERA_DEVICE_REAR"
  [ -n "$VOICE_WAKE" ]         && echo "Environment=VOICE_WAKE=$VOICE_WAKE"
  [ -n "$RTC_ENABLE" ]         && echo "Environment=RTC_ENABLE=$RTC_ENABLE"
  [ -n "$CAMERA_ENABLE" ]      && echo "Environment=CAMERA_ENABLE=$CAMERA_ENABLE"
  [ -n "$RTC_BITRATE" ]        && echo "Environment=RTC_BITRATE=$RTC_BITRATE"
  [ -n "$RTC_FPS" ]            && echo "Environment=RTC_FPS=$RTC_FPS"
  cat <<EOF
ExecStart=$NODE_BIN robot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
} | sudo tee "$SERVICE" >/dev/null

echo "✅ Service écrit dans $SERVICE"

# Droits d'acces : ports serie (dialout) + webcam (video) + micro/ALSA (audio)
sudo usermod -aG dialout "$USER_NAME" || true
sudo usermod -aG video "$USER_NAME" || true
sudo usermod -aG audio "$USER_NAME" || true

sudo systemctl daemon-reload
sudo systemctl enable ping-robot
sudo systemctl restart ping-robot
echo "✅ Service activé et démarré."
echo "   Voir les logs en direct :  journalctl -u ping-robot -f"
