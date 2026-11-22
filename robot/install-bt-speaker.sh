#!/usr/bin/env bash
# install-bt-speaker.sh — Fiabilise l'enceinte Bluetooth du robot.
#
# Probleme resolu : sur le Pi, bluetoothd demarre AVANT que la cle Bluetooth
# USB ait fini de charger son firmware. Resultat, il ne la voit pas et
# l'adaptateur reste eteint (hci0 DOWN) apres chaque redemarrage, meme avec
# AutoEnable=true. Ce service attend que la cle soit prete, l'allume, puis
# laisse le robot rappeler l'enceinte (tts.ensureConnectedAtStartup).
#
# A lancer SUR LE PI, une seule fois :
#   chmod +x install-bt-speaker.sh && sudo ./install-bt-speaker.sh
set -e

SERVICE=/etc/systemd/system/bt-adapter-up.service
UDEV_RULE=/etc/udev/rules.d/99-ping-bluetooth-power.rules

# Le noyau signale des plantages de cette cle Realtek ("RTL: hw err, trigger
# devcoredump"). On supprime le cycle suspend/reveil USB comme facteur
# aggravant possible. La regle est reappliquee a chaque re-enumeration de la
# cle, avant meme que BlueZ ne tente de l'utiliser.
cat > "$UDEV_RULE" <<'EOF'
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="0bda", ATTR{idProduct}=="a728", TEST=="power/control", ATTR{power/control}="on"
EOF
udevadm control --reload-rules

cat > "$SERVICE" <<'EOF'
[Unit]
Description=Allume la cle Bluetooth USB (apres chargement du firmware)
After=bluetooth.service
Wants=bluetooth.service

[Service]
# Surveillance PERMANENTE et non plus simple allumage au demarrage : la cle
# USB Realtek plante parfois (hw err/devcoredump), se re-enumere et peut alors
# changer de numero. Ce service stabilise uniquement l'adaptateur ; le robot
# reste le seul composant charge de rappeler l'enceinte.
Type=simple
Restart=always
RestartSec=10
ExecStart=/usr/local/bin/bt-watchdog.sh

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/bt-watchdog.sh <<'WD'
#!/bin/sh
# Surveille uniquement la cle Bluetooth et la repare si besoin.
# La reconnexion de l'enceinte appartient au robot (tts.js) pour eviter deux
# boucles concurrentes qui tentent de la reconnecter en meme temps.
# Identifiants USB de la cle Realtek (lsusb : 0bda:a728).
BT_VENDOR="${BT_VENDOR:-0bda}"
BT_PRODUCT="${BT_PRODUCT:-a728}"
rfkill unblock bluetooth 2>/dev/null

# Empeche la mise en veille de CETTE cle uniquement. Le journal noyau montre
# des plantages du firmware Realtek ("RTL: hw err, trigger devcoredump") ; on
# evite qu'un cycle suspend/reveil USB les declenche ou les aggrave.
# power/control=on interdit le runtime suspend ; -1 rend aussi le delai
# d'autosuspend infini. La fonction est silencieuse si le reglage est deja bon.
disable_usb_bt_autosuspend() {
  for dev in /sys/bus/usb/devices/*; do
    [ -f "$dev/idVendor" ] || continue
    [ "$(cat "$dev/idVendor")" = "$BT_VENDOR" ] || continue
    [ "$(cat "$dev/idProduct")" = "$BT_PRODUCT" ] || continue
    if [ -w "$dev/power/control" ] && [ "$(cat "$dev/power/control" 2>/dev/null)" != "on" ]; then
      echo "  desactivation de l'autosuspend USB pour $(basename "$dev")"
      echo on > "$dev/power/control"
    fi
    if [ -w "$dev/power/autosuspend_delay_ms" ] && [ "$(cat "$dev/power/autosuspend_delay_ms" 2>/dev/null)" != "-1" ]; then
      echo -1 > "$dev/power/autosuspend_delay_ms"
    fi
  done
}

# Coupe puis retablit l'alimentation logique du peripherique USB : c'est
# l'equivalent d'un debranchement/rebranchement a la main.
reset_usb_bt() {
  for dev in /sys/bus/usb/devices/*; do
    [ -f "$dev/idVendor" ] || continue
    [ "$(cat "$dev/idVendor")" = "$BT_VENDOR" ] || continue
    [ "$(cat "$dev/idProduct")" = "$BT_PRODUCT" ] || continue
    echo "  reset USB de $(basename "$dev")"
    echo 0 > "$dev/authorized" 2>/dev/null
    sleep 3
    echo 1 > "$dev/authorized" 2>/dev/null
    sleep 3
    disable_usb_bt_autosuspend
    return 0
  done
  echo "  cle USB 0bda:a728 introuvable (debranchee ?)"
  return 1
}

disable_usb_bt_autosuspend

# PRUDENCE (lecon du 01/08) : une verification qui echoue une fois ne veut
# rien dire — bluetoothctl peut simplement tarder a repondre sur un Pi charge.
# Une premiere version relancait bluetoothd des le premier echec, ce qui
# COUPAIT l'enceinte qui marchait tres bien, puis la reconnectait : c'est la
# surveillance elle-meme qui provoquait les deconnexions a repetition.
# On n'agit donc qu'apres plusieurs echecs consecutifs du controleur.
echecs=0

while true; do
  # --- Cas critique : adaptateur present mais PAS en hci0 ---
  # Le module audio de BlueZ (avdtp) cherche "hci0" en dur. Si la cle a pris
  # l'index hci1 (re-enumeration USB), bluetoothd PLANTE des qu'une lecture
  # audio commence : "Can't open device hci0" -> exit 1. systemd le relance,
  # l'enceinte se reconnecte, replante... d'ou les coupures a repetition.
  # Recharger le pilote remet la numerotation a zero et rend l'index hci0.
  if ls /sys/class/bluetooth 2>/dev/null | grep -q hci && \
     ! ls /sys/class/bluetooth 2>/dev/null | grep -qx hci0; then
    echo "adaptateur sur $(ls /sys/class/bluetooth | tr '\n' ' ')au lieu de hci0 -> rechargement du pilote"
    modprobe -r btusb 2>/dev/null
    sleep 3
    modprobe btusb 2>/dev/null
    sleep 10
    disable_usb_bt_autosuspend
    for h in $(ls /sys/class/bluetooth 2>/dev/null); do hciconfig "$h" up 2>/dev/null; done
    systemctl restart bluetooth
    sleep 6
    bluetoothctl power on >/dev/null 2>&1
    echo "  adaptateurs apres rechargement : $(ls /sys/class/bluetooth 2>/dev/null | tr '\n' ' ')"
    sleep 20
    continue
  fi

  # Adaptateur visible par bluetoothd ?
  if bluetoothctl list 2>/dev/null | grep -q Controller; then
    # Tout va bien : on ne touche ni a bluetoothd ni a l'enceinte.
    disable_usb_bt_autosuspend
    echecs=0
    sleep 30
    continue
  fi

  # Pas de controleur : on attend 3 echecs d'affilee (90 s) avant d'agir.
  echecs=$((echecs + 1))
  echo "aucun controleur (echec $echecs/3)"
  if [ "$echecs" -lt 3 ]; then
    sleep 30
    continue
  fi

  # Reparation, du plus doux au plus radical.
  for h in $(ls /sys/class/bluetooth 2>/dev/null); do hciconfig "$h" up 2>/dev/null; done
  if ls /sys/class/bluetooth 2>/dev/null | grep -q hci; then
    echo "reparation : relance de bluetoothd"
    systemctl restart bluetooth
    sleep 6
    bluetoothctl power on >/dev/null 2>&1
  fi

  if ! bluetoothctl list 2>/dev/null | grep -q Controller; then
    # Coupe/retablit l'autorisation USB : equivalent d'un debranchement.
    # (Ne PAS detacher le pilote btusb interface par interface : essaye le
    # 31/07, la cle disparaissait completement et ne revenait pas.)
    echo "reparation : re-branchement logiciel de la cle"
    reset_usb_bt
    sleep 10
    disable_usb_bt_autosuspend
    for h in $(ls /sys/class/bluetooth 2>/dev/null); do hciconfig "$h" up 2>/dev/null; done
    systemctl restart bluetooth
    sleep 5
    bluetoothctl power on >/dev/null 2>&1
  fi

  # Dernier recours : recharger le pilote btusb. Quand la cle enumere deux fois
  # au demarrage (alimentation instable), elle recupere l'index hci1 — et
  # bluetoothd, qui cherche hci0, plante en boucle des qu'on lit de l'audio.
  # Recharger le module remet la numerotation a zero et rend l'index hci0.
  if ! bluetoothctl list 2>/dev/null | grep -q Controller; then
    echo "reparation : rechargement du pilote btusb (retour a hci0)"
    modprobe -r btusb 2>/dev/null
    sleep 3
    modprobe btusb 2>/dev/null
    sleep 8
    disable_usb_bt_autosuspend
    for h in $(ls /sys/class/bluetooth 2>/dev/null); do hciconfig "$h" up 2>/dev/null; done
    systemctl restart bluetooth
    sleep 5
    bluetoothctl power on >/dev/null 2>&1
    echo "  adaptateurs : $(ls /sys/class/bluetooth 2>/dev/null | tr '\n' ' ')"
  fi
  echecs=0
  sleep 30
done
WD
chmod +x /usr/local/bin/bt-watchdog.sh

systemctl daemon-reload
systemctl enable bt-adapter-up.service
# restart et non start : un service "oneshot" avec RemainAfterExit est deja
# considere comme actif, "start" ne relancerait donc rien.
systemctl restart bt-adapter-up.service

# Allumage immediat (le script tourne en root, autant en profiter tout de suite)
echo "--- allumage ---"
rfkill unblock bluetooth 2>/dev/null || true
for dev in /sys/bus/usb/devices/*; do
  [ -f "$dev/idVendor" ] || continue
  [ "$(cat "$dev/idVendor")" = "0bda" ] || continue
  [ "$(cat "$dev/idProduct")" = "a728" ] || continue
  [ -w "$dev/power/control" ] && echo on > "$dev/power/control"
  [ -w "$dev/power/autosuspend_delay_ms" ] && echo -1 > "$dev/power/autosuspend_delay_ms"
  echo "  autosuspend USB desactive pour $(basename "$dev")"
done
for h in $(ls /sys/class/bluetooth 2>/dev/null); do
  if hciconfig "$h" up 2>/dev/null; then
    echo "  $h allume"
  else
    echo "  $h : echec ($(hciconfig "$h" up 2>&1 | head -1))"
  fi
done
# bluetoothd doit etre relance APRES l'allumage : s'il a demarre avant que la
# cle soit prete, il n'a aucun controleur ("No default controller available").
echo "--- relance de bluetoothd ---"
systemctl restart bluetooth
sleep 3
bluetoothctl power on >/dev/null 2>&1 || true
sleep 1
bluetoothctl show 2>/dev/null | grep -E 'Controller|Powered' | head -2

echo "--- etat ---"
hciconfig | grep -E '^hci|UP|DOWN' || true
bluetoothctl list 2>/dev/null | head -2
bluetoothctl info FD:50:32:26:7F:54 2>/dev/null | grep -E 'Connected' || true
echo
echo "Surveillance active : la cle reste allumee et hors autosuspend USB."
echo "Le robot reste le seul composant autorise a rappeler l'enceinte."
echo "Suivre en direct :  journalctl -u bt-adapter-up -f"
