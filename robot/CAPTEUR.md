# Envoyer les données du capteur au serveur (WebSocket)

Tu produis les lignes de mesure ; tout le transport jusqu'au serveur est déjà fait. Le robot envoie chaque ligne au
serveur par un WebSocket, le serveur la range dans un fichier CSV, et l'algo de Tom (`map_sonar.py`) transforme ce
fichier en carte.

```
Ton code ──lignes──▶ capteur.js (sur le Pi) ──WebSocket /ws/capteur──▶ Serveur Ping ──▶ server/capteur/CODE/SESSION.csv
(Arduino, robot.js    file d'attente,          ◀──────── ack ─────────    vérifie chaque            │
 ou autre programme)  envoi toutes les 200 ms,                            ligne                    │ GET /capteur/SESSION
                      renvoi après coupure                                                          ▼
                                                                              map_sonar.py (Tom) ──▶ carte.png
```

Ce qui est en place :

- **Sur le robot** : `robot/capteur.js`, branché dans `robot.js`. Il met tes lignes en file d'attente, les envoie
  toutes les 200 ms, les renvoie après une coupure et se reconnecte tout seul.
- **Sur l'Arduino** : toute ligne de 5 champs écrite sur le port série est transmise automatiquement au serveur.
- **Sur le serveur** : le WebSocket `/ws/capteur` vérifie chaque ligne et l'ajoute au fichier
  `server/capteur/<code>/<session>.csv` ; `GET /capteur/<session>` permet de le télécharger.
- **Testé** : 119 lignes sur 119 reçues en coupant puis relançant le serveur pendant l'envoi.

## Le format d'une ligne

Une mesure = une ligne de 5 valeurs séparées par des virgules, dans cet ordre :
`x_m,y_m,heading_deg,sensor_angle_deg,distance_cm`. C'est exactement le format que lit `map_sonar.py`.

| Champ | Unité | Sens |
| --- | --- | --- |
| `x_m` | mètres | position X du robot |
| `y_m` | mètres | position Y du robot |
| `heading_deg` | degrés | cap du robot, compté dans le sens inverse des aiguilles d'une montre depuis l'axe X |
| `sensor_angle_deg` | degrés | angle du capteur par rapport à l'avant du robot (0 = capteur fixe vers l'avant) |
| `distance_cm` | centimètres | distance mesurée ; **vide = pas d'écho** |

```
0,0,0,0,143          robot à l'origine, face à l'axe X, obstacle à 143 cm
0,0,0,0,             même position, pas d'écho (rien à moins de ~4 m)
0.5,1.2,90,-30,87.5  décimales avec un point, valeurs négatives acceptées
```

Règles vérifiées par le serveur :

- exactement 5 champs ; les espaces autour des valeurs sont tolérés ;
- les 4 premiers champs sont des nombres (négatifs acceptés) ;
- la distance est un nombre positif, ou vide ;
- la ligne d'en-tête `x_m,y_m,heading_deg,sensor_angle_deg,distance_cm` est acceptée et ignorée ;
- une ligne invalide est refusée seule, avec sa raison ; les autres lignes du même envoi sont gardées.

## Mise en route

1. Sur le Pi **et** sur le serveur, récupérer la branche (tant que la PR #3 n'est pas fusionnée) :
   ```sh
   git fetch && git checkout feat/websocket-connexion-robot-server
   ```
2. Sur le Pi, une seule fois (ajoute le paquet `ws`) :
   ```sh
   cd robot && npm install
   ```
3. Sur le serveur :
   ```sh
   cd server && uv sync && PORT=3000 uv run ping-server
   ```
4. Sur le Pi :
   ```sh
   CODE=1234 SERVER_URL=http://<serveur>:3000 node robot.js
   ```
   Le robot ouvre la connexion tout seul au démarrage et affiche `Capteur: connecte au serveur, session …`.

| Variable (robot) | Défaut | Rôle |
| --- | --- | --- |
| `CAPTEUR_ENABLE` | `true` | `false` coupe l'envoi |
| `CAPTEUR_SESSION` | vide | nom du fichier côté serveur ; vide = une nouvelle session à chaque démarrage |
| `ROBOT_KEY` | vide | même valeur que `ROBOT_KEY` du serveur, seulement si elle y est configurée |

## Envoyer tes données

Choisis selon l'endroit où tourne ton code ; les deux premières façons profitent de la file d'attente et de la
reconnexion automatique.

### 1. Depuis l'Arduino (le plus simple)

Écris la ligne sur le port série qui relie déjà l'Arduino au Pi. `robot.js` reconnaît toute ligne de 5 champs et
l'envoie au serveur.

```cpp
void envoyerMesure(float x, float y, float cap, float angle, long cm) {
  Serial.print(x);     Serial.print(',');
  Serial.print(y);     Serial.print(',');
  Serial.print(cap);   Serial.print(',');
  Serial.print(angle); Serial.print(',');
  if (cm > 0) Serial.print(cm);   // rien = pas d'écho
  Serial.println();
}
```

- Que des nombres sur la ligne, sans préfixe comme `D:` ; les lignes `D:`, `ACK:` et le reste continuent d'être
  traitées comme avant.
- La liaison à 9600 bauds est partagée avec les commandes moteur : reste sous ~20 lignes par seconde.

### 2. Depuis `robot.js` (Node, sur le Pi)

Appelle `capteur.envoyer` là où ta mesure est prête, par exemple dans `onSensor`, qui reçoit les lignes `D:<cm>` de
l'Arduino :

```js
capteur.envoyer([x, y, cap, angleCapteur, distanceCm]);   // distanceCm = null si pas d'écho
capteur.envoyer('0.5,0,90,0,143');                       // ou la ligne déjà formée
capteur.nouvelleSession();                               // nouveau fichier côté serveur
```

`envoyer` ne bloque jamais : il met la ligne en file et rend la main tout de suite, même si le réseau est coupé.

### 3. Depuis un autre programme (Python, etc.)

Ton programme se connecte directement au serveur, avec le même protocole :

```python
import asyncio
from websockets.asyncio.client import connect

async def main():
    async with connect("ws://<serveur>:3000/ws/capteur?code=1234&session=essai-1") as ws:
        print(await ws.recv())                  # {"type":"bonjour",...}
        await ws.send("0,0,0,0,143\n0,0,0,10,")
        print(await ws.recv())                  # {"type":"ack","recues":2,...}

asyncio.run(main())
```

Attention : ici, pas de file d'attente ni de reconnexion. Si la connexion coupe, ce qui est envoyé pendant ce temps
est perdu ; pour un usage durable, préfère les façons 1 ou 2.

## Le protocole WebSocket en détail

Un WebSocket ordinaire (pas Socket.IO) : le robot envoie du texte, le serveur répond en JSON, un accusé par message.
`capteur.js` le fait pour toi ; ce détail sert pour la façon 3 ou pour déboguer.

**Adresse** : `ws://<serveur>:3000/ws/capteur?code=<code>&session=<session>&cle=<ROBOT_KEY>` ; derrière nginx,
`wss://api.ping-app.org/ping/ws/capteur?…`.

| Paramètre | Obligatoire | Rôle |
| --- | --- | --- |
| `code` | oui | code du salon du robot |
| `session` | non | fichier où ranger les lignes (lettres, chiffres, `_` et `-`, 64 caractères max) ; absent = le serveur en crée une |
| `cle` | si `ROBOT_KEY` est configurée sur le serveur | valeur de `ROBOT_KEY` |

Déroulement :

1. Le robot ouvre la connexion ; le serveur répond `bonjour`.
2. Le robot envoie un message texte contenant une ou plusieurs lignes, séparées par un retour à la ligne.
3. Le serveur ajoute les lignes valides au fichier de la session et répond `ack`, dans l'ordre des messages.
4. En cas de problème, le serveur envoie `erreur` puis ferme la connexion.

| Message du serveur | Exemple | Quand |
| --- | --- | --- |
| `bonjour` | `{"type":"bonjour","code":"1234","session":"s-20261121-150000","lignes":0}` | à la connexion ; `lignes` = déjà reçues dans cette session |
| `ack` | `{"type":"ack","recues":2,"rejetees":1,"total":120,"erreurs":[…]}` | après chaque message ; `erreurs` liste au plus 5 lignes refusées avec leur raison |
| `erreur` | `{"type":"erreur","erreur":"cle robot invalide"}` | code manquant, clé invalide, session invalide, session de plus de 50 Mo |

**Sessions** : une session = un fichier `server/capteur/<code>/<session>.csv`. `capteur.js` en crée une à chaque
démarrage du robot (`s-AAAAMMJJ-hhmmss`) et la garde d'une reconnexion à l'autre, donc une coupure ne coupe pas le
fichier en deux.

**Fiabilité** : `capteur.js` garde chaque ligne tant que le serveur ne l'a pas accusée. Après une coupure, il se
reconnecte (attente de 1 s, puis 2, 4… jusqu'à 10 s) et renvoie les lignes non accusées. Si le serveur reste
injoignable très longtemps, il garde au plus 100 000 lignes et jette les plus anciennes. Une ligne peut
exceptionnellement arriver en double si la coupure tombe entre son enregistrement et l'accusé.

Le même protocole est décrit dans le Swagger du serveur (`/docs`), sections « WebSocket · Capteur » et
« HTTP · Capteur ».

## Vérifier et déboguer

Le test le plus rapide : taper `capteur 0,0,0,0,143` dans le terminal de `robot.js`, puis regarder la ligne arriver
dans le fichier du serveur.

Sans robot sous la main, `server/sonar-mapping/simuler_robot.py` se fait passer pour lui et envoie un parcours
complet de mesures ; voir [Tester sans robot](../server/README.md#tester-sans-robot--le-simulateur).

| Où | Commande ou message | Ce que ça dit |
| --- | --- | --- |
| Terminal de `robot.js` | `capteur` | état : `session`, `connecte`, `enAttente`, `acceptees`, `perdues` |
| Terminal de `robot.js` | `capteur 0,0,0,0,143` | envoie une ligne de test |
| Terminal de `robot.js` | `capteur session` | commence une nouvelle session (nouveau fichier) |
| Logs du robot | `Capteur: connecte au serveur, session …` | la connexion est ouverte |
| Logs du robot | `Capteur: N ligne(s) refusee(s) par le serveur : […]` | le format est faux ; la raison est donnée |
| Logs du serveur | `[CAPTEUR] 1234 : robot connecte depuis 192.168.1.20:36942, session …` | le serveur voit le robot (et d'où il se connecte) |
| Logs du serveur | `[CAPTEUR] 1234 : message recu, 2 ligne(s) acceptee(s), 0 refusee(s), total 120 - derniere : 0,0,0,0,143` | un message par envoi du robot (jusqu'à 5 par seconde) |
| Logs du serveur | `[CAPTEUR] 1234 : resume 1 s -> 5 message(s), 10 ligne(s) acceptee(s), 0 refusee(s), total 120` | le bilan de chaque seconde |
| Logs du serveur | `[CAPTEUR] 1234 : robot deconnecte (session …, 18 ligne(s) recue(s) pendant cette connexion, …)` | fin de connexion, avec sa durée |
| Logs du serveur | `[CAPTEUR] connexion refusee depuis … : cle robot invalide` | un robot ou programme refusé, et pourquoi |
| Serveur | `tail -f server/capteur/1234/<session>.csv` | les lignes arrivent en direct |
| Serveur | `uv run ping-server 2>&1 \| grep --line-buffered CAPTEUR` | seulement les logs du capteur |
| Serveur | `curl "http://localhost:3000/capteur?code=1234"` | sessions et nombre de lignes |

Quand `robot.js` tourne en service systemd, son terminal n'accepte pas de commandes ; les logs se lisent avec
`journalctl -u ping-robot -f | grep Capteur`.

| Message | Cause | Correction |
| --- | --- | --- |
| `5 champs attendus (…), 3 recus` | virgule manquante ou en trop | toujours 5 champs, même vides : `0,0,0,0,` |
| `x_m doit etre un nombre` | texte, unité ou virgule décimale | `0.5` et non `0,5` ni `0.5m` |
| `distance_cm doit etre un nombre positif ou vide` | distance négative (`-1`) | laisser vide pour « pas d'écho » |
| `cle robot invalide` | `ROBOT_KEY` différente entre robot et serveur | la même valeur des deux côtés |
| Rien n'arrive, `connecte: false` | serveur injoignable ou mauvais `SERVER_URL` | vérifier l'adresse ; les lignes attendent dans `enAttente` et partiront à la reconnexion |

Le robot n'écrit rien quand il perd la liaison ou réessaie : en cas de doute, tape `capteur` et regarde `connecte` et
`enAttente`.

## Récupérer les données pour la carte de Tom

Le fichier d'une session se passe tel quel à `map_sonar.py` : pas de conversion, l'en-tête est déjà le bon.

```sh
curl "http://<serveur>:3000/capteur?code=1234"                       # liste des sessions
curl -o session.csv "http://<serveur>:3000/capteur/<session>?code=1234"
uv run --locked --script server/sonar-mapping/map_sonar.py session.csv carte.png
```

Pour voir la carte se dessiner dans l'app, la carte sonar en direct affiche l'image que `map_sonar.py` écrit dans le
fichier `SONAR_SNAPSHOT_FILE` ; la marche à suivre est dans `server/sonar-mapping/README.md`.