# 🤖 Robot Ping — Raspberry Pi 3

Client headless qui connecte un Raspberry Pi 3 à ton app **Ping**. Le robot
s'appaire avec le même **code** que ton contact, lit sa position d'un **module
GPS** réel, et peut **initier** ou **accepter** une demande « Se rejoindre ».

Il parle exactement le même protocole socket.io que le serveur Python ([`server/`](../server/README.md)).

---

## 1. Câblage du module GPS (NEO-6M ou compatible)

| Module GPS | Raspberry Pi 3 |
|-----------|----------------|
| VCC       | 5V (pin 2) ou 3V3 (pin 1) selon le module |
| GND       | GND (pin 6) |
| TX        | RXD — GPIO15 (pin 10) |
| RX        | TXD — GPIO14 (pin 8) |

> ⚠️ TX du GPS va sur **RX** du Pi, et RX du GPS sur **TX** du Pi (croisé).

## 2. Activer l'UART du Pi

```bash
sudo raspi-config
# Interface Options -> Serial Port
#   "login shell over serial?"   -> NON
#   "serial port hardware enabled?" -> OUI
sudo reboot
```

Le port série matériel devient `/dev/serial0`. Vérifie que des trames NMEA
arrivent :

```bash
cat /dev/serial0
# tu dois voir défiler des lignes commençant par $GPRMC, $GPGGA, ...
```

> GPS branché en **USB** ? Utilise plutôt `GPS_PORT=/dev/ttyUSB0`.

## 3. Installer Node.js et les dépendances

```bash
# Node LTS (si pas déjà installé)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

cd robot
npm install
```

## 4. Lancer le robot

```bash
# CODE = le même code que ton contact dans l'app
CODE=123456 node robot.js
```

Options (variables d'environnement) :

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CODE` | — (requis) | Code d'appairage, identique à ton contact |
| `PSEUDO` | `Robot` | Nom du robot (doit différer du contact) |
| `SERVER_URL` | `http://<ip-serveur>:3000` | Adresse de ton serveur VPS |
| `GPS_PORT` | `/dev/serial0` | Port du GPS (`/dev/ttyUSB0` si USB) |
| `GPS_BAUD` | `9600` | Vitesse du module GPS |
| `AUTO_ACCEPT` | `true` | Accepter automatiquement les demandes reçues |
| `SHARE_INTERVAL_MS` | `5000` | Fréquence d'envoi de la position |
| `ARRIVAL_RADIUS_M` | `15` | Distance « arrivé » (mètres) |
| `NAV_ENABLE` | `true` | Navigation auto (pilotage Arduino) |
| `ARDUINO_PORT` | `/dev/ttyACM0` | Port série de l'Arduino |
| `ARDUINO_BAUD` | `9600` | Vitesse série Arduino |
| `NAV_TICK_MS` | `700` | Fréquence des ordres de pilotage |
| `NAV_ANGLE_TOL` | `20` | Tolérance de cap avant d'avancer (°) |
| `NAV_GPS_MEASURE_TICKS` | `3` | Nombre de ticks d'avance après une correction GPS |
| `OBSTACLE_STOP_CM` | `25` | Distance d'évitement d'obstacle (cm) |
| `COMPASS_ENABLE` | `true` | Mettre `false` pour ignorer la boussole et naviguer au cap GPS |
| `COMPASS_INVERT` | `false` | Mettre `true` si la boussole tourne dans le sens inverse |

Exemple complet :

```bash
CODE=123456 PSEUDO=RobotBleu GPS_PORT=/dev/ttyUSB0 node robot.js
```

## SFM-27 buzzer alarm

The existing app alarm button controls the SFM-27 when the Pi runs with
`ALARM_BUZZER=true`. The speaker alarm remains the default. Flash
[`rover_uart.ino`](arduino/rover_uart/rover_uart.ino) and set
`Environment=ALARM_BUZZER=true` in the Pi's service configuration, then restart
the service. For a manual launch, set `ALARM_BUZZER=true` alongside `CODE`.

Wire the buzzer as a low-side switched load.

- Connect buzzer positive to the +12 V supply and buzzer negative to the MOSFET drain.
- Connect the MOSFET source, supply negative and Arduino GND together.
- Arduino A0 drives the gate driver input. Fit a 10 kΩ gate-to-source pull-down
  to hold the switch off during reset. With the IRFZ44N, use a driver that
  accepts the Arduino's 5 V signal and supplies a 10 V gate drive. Infineon
  specifies the on-resistance at 10 V gate-to-source.
  [IRFZ44N datasheet](https://www.infineon.com/assets/row/public/documents/24/49/infineon-irfz44n-datasheet-en.pdf)

Long-press the app's alarm button to sound the buzzer. Tap it or use emergency
stop to silence it. The Pi sends `A1` every 500 ms while the alarm is active
and sends `A0` to stop it. The Arduino switches the buzzer off 1.5 seconds
after the last renewal if the Pi or serial link fails.

## 5. Commandes au clavier (une fois lancé)

```
join          le robot envoie une demande "Se rejoindre" au contact
accept        accepter une demande reçue (si AUTO_ACCEPT=false)
stop          annuler le "Se rejoindre" en cours
pos           afficher la dernière position GPS du robot
msg <texte>   envoyer un message au contact
drive <X>     test moteur direct : X = F (avance) B (recule) L R S (stop)
help          afficher l'aide
quit          quitter
```

## 5 bis. Arduino — moteurs & déplacement automatique

Le Raspberry Pi décide *où aller* (GPS), l'Arduino *fait rouler* le robot.
Ils sont reliés par le **câble USB** (port `/dev/ttyACM0` en général).

**a) Téléverser le programme Arduino**

Ouvre [`arduino/robot_motors.ino`](arduino/robot_motors.ino) dans l'IDE Arduino,
**adapte les numéros de broches** à ton câblage (drivers L298N + capteur HC-SR04),
puis téléverse sur la carte.

| Roue / canal L298N | Arduino (défaut du sketch) |
|--------------------|-----------------------------|
| Avant gauche EN / IN1 / IN2 | D5 / D6 / D7 |
| Avant droite EN / IN1 / IN2 | D10 / D8 / D9 |
| Arrière gauche EN / IN1 / IN2 | D11 / D12 / D13 |
| Arrière droite EN / IN1 / IN2 | A0 / A1 / A2 |
| HC-SR04 TRIG / ECHO | D3 / D2 |

> Pour un châssis 4 roues avec **un seul L298N**, branche les 2 moteurs gauches
> ensemble sur OUT1/OUT2 et les 2 moteurs droits ensemble sur OUT3/OUT4. Le code
> pilote alors un côté gauche et un côté droit. Pour piloter chaque roue
> séparément, il faut 2 L298N ou un driver 4 canaux.

Si `drive F` fait tourner le robot sur lui-même, une ou plusieurs roues sont
inversées. Dans `robot_motors.ino`, change le dernier champ `invert` de la roue
concernée (`true` / `false`) jusqu'à ce que toutes les roues aillent vers l'avant
quand tu envoies `F`.

**b) Vérifier la liaison Pi ↔ Arduino**

```bash
ls /dev/ttyACM*        # le port de l'Arduino
```

Lance le robot puis teste un moteur **roues en l'air** :

```
drive F      # le robot doit avancer
drive S      # stop
```

**c) Comment marche la navigation auto**

Pendant un « Se rejoindre », le Pi calcule le **cap vers le contact** et envoie
`F` / `L` / `R` / `S` à l'Arduino jusqu'à arriver (rayon `ARRIVAL_RADIUS_M`).
Le capteur ultrason déclenche un évitement si un obstacle est à moins de
`OBSTACLE_STOP_CM`.

> ⚠️ **Important — le cap.** Sans boussole, le GPS ne donne la direction du
> robot que **lorsqu'il roule**. La navigation fonctionne donc mais peut
> « zigzaguer » à basse vitesse. Pour un cap précis et stable, ajoute un
> **magnétomètre** (HMC5883L / QMC5883) — on pourra l'intégrer ensuite.

## 6. Le faire tourner en permanence (optionnel)

Créer un service systemd `/etc/systemd/system/ping-robot.service` :

```ini
[Unit]
Description=Ping Robot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/ping/robot
Environment=CODE=123456
ExecStart=/usr/bin/node robot.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ping-robot
journalctl -u ping-robot -f   # voir les logs en direct
```

---

## Comment ça marche (résumé)

1. Le robot se connecte au serveur et envoie `pair { pseudo, code }`.
2. Ton app (même code) le voit arriver → tu es « appairé » avec le robot.
3. **Tu lances « Se rejoindre » depuis l'app** → le robot reçoit la demande,
   l'accepte et envoie sa position GPS → tu vois le robot sur la carte et tu
   peux ouvrir l'itinéraire vers lui.
4. **Ou le robot lance `join`** → ton app reçoit la demande, tu acceptes, et
   vous échangez vos positions.

> Note : `react-native-maps` n'est pas disponible dans Expo Go. Le robot
> partage bien sa position (utilisable pour l'itinéraire), mais l'aperçu
> carte ne s'affiche que dans un *development build* de l'app.
