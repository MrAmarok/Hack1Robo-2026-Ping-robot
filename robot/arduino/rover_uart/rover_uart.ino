// =====================================================================
//  ROVER — version UART, pour l'app Node du Raspberry Pi
//  9600 bauds sur /dev/serial0, commandes d'une lettre, ACK:<lettre>
//
//  C'EST CE SKETCH QUI EST FLASHE SUR LE ROBOT (verifie le 17/09/2026).
//  Les autres dossiers de robot/arduino/ (wildthumper, robot_motors,
//  elegoo_*, *_test) sont d'anciens montages : brochage different,
//  ne pas les flasher sur celui-ci.
//
//  IMPORTANT, A LIRE AVANT DE CABLER
//  1) /dev/serial0 c'est l'UART GPIO du Pi (broches 8 et 10), pas l'USB.
//     Cote Arduino ce sont D0 (RX) et D1 (TX) : LES MEMES que l'USB.
//     -> debranche les fils du Pi pendant chaque televersement,
//        sinon l'upload echoue.
//  2) Le Pi est en 3,3 V, l'Arduino en 5 V. La ligne
//     Arduino TX (D1) -> Pi RX (broche 10) DOIT passer par un pont
//     diviseur 1 kO / 2 kO, sinon tu detruis l'entree du Pi.
//     L'autre sens, Pi TX -> Arduino RX, se branche en direct.
//  3) Croise les fils : TX de l'un sur RX de l'autre.
//
//  ---------------------------------------------------------------
//  CE QUI A CHANGE PAR RAPPORT A LA VERSION PRECEDENTE (17/09/2026)
//
//  1) vitesse = 255 au demarrage, au lieu de 160.
//     L'ancienne valeur bridait les moteurs a 63 % en permanence :
//     l'app n'envoyait aucun V, donc rien ne la remontait jamais. Le
//     robot n'arrivait pas a tourner, faute de couple.
//
//  2) Le tilt accepte 'U' en plus de 'T'.
//     robot.js envoie U<angle> (handleCamMove), pas T<angle> : le tilt
//     etait donc totalement inoperant depuis l'app.
//
//  3) 'C' recentre la camera au lieu de fermer le couvercle.
//     Cote app, 'C' est le bouton "recentrer la camera". Il fermait
//     donc le couvercle, ce que personne ne demandait. Le couvercle a
//     desormais ses propres commandes, sans ambiguite (voir K).
//
//  4) 'V' seul ne met plus la vitesse a zero.
//     atoi("") vaut 0 : un 'V' sans chiffre arretait le rover net.
//     Meme garde-fou que celui qui existait deja pour P et T.
//
//  5) Le boot annonce READY:rover_uart au lieu d'un READY nu, et la
//     commande 'I' le redemande a chaud. Avec une dizaine de sketches
//     dans le dossier, pouvoir demander "qui es-tu ?" evite de flasher
//     a l'aveugle. ATTENTION : ce sketch repond ACK:<lettre> a
//     N'IMPORTE QUELLE lettre, meme inconnue — un ACK ne prouve donc
//     jamais qu'une commande est reellement implementee. Seuls READY
//     et 'I' identifient le sketch de facon fiable.
//
//  ---------------------------------------------------------------
//  PROTOCOLE COMPLET
//     F / B          avancer / reculer
//     L / R          tourner a gauche / a droite (contre-rotation)
//     S              stop
//     V<n>           vitesse 0..255 (ex "V255")
//     P<n>           rotation camera (pan),     bornee ROT_MIN..ROT_MAX
//     U<n> ou T<n>   inclinaison camera (tilt), bornee INC_MIN..INC_MAX
//     C              recentrer la camera (pan et tilt a 90)
//     O   ou K1      ouvrir le couvercle
//     K0             fermer le couvercle
//     G<n>           equilibrage cote gauche, 0..100 % (100 = plein)
//     H<n>           equilibrage cote droit,   0..100 %
//     J<n>           PWM de depart du demarrage progressif (0..255)
//     M<g>,<d>       pilotage DIFFERENTIEL : une vitesse par cote, en % de
//                    la vitesse courante, de -100 a +100 (negatif = arriere).
//                    Ex : M100,100 = tout droit · M100,60 = arc a droite
//                         M-100,100 = pivot a gauche · M0,80 = vire sur place
//                    Direct, sans rampe : c'est la commande d'un regulateur
//                    (maintien de cap), et une rampe le ferait osciller.
//     I              reafficher READY:rover_uart
//
//  CE QUE LE SKETCH ENVOIE DE LUI-MEME
//     PRES:<0|1>     presence detectee par le radar (changements seulement)
//     D:x,y,rotation,0,cm         distance mesuree devant, une fois par seconde
//                    (robot.js l'attend pour son evitement d'obstacles)
// =====================================================================

#include <Servo.h>

const uint8_t G_RPWM = 5,  G_LPWM = 6;
const uint8_t D_RPWM = 3,  D_LPWM = 11;
const uint8_t EN_PONTS = 4;
// Sens de rotation par cote. Le cote DROIT est cable a l'envers sur ce
// chassis : sans D_INVERT, 'F' fait pivoter le robot sur place et 'L'/'R'
// le font avancer/reculer (constate le 14/11/2026 apres un reflash d'une
// version qui avait perdu ce reglage). Test fiable : robot AU SOL, 'F'.
const bool G_INVERT = false;
const bool D_INVERT = true;
const uint8_t PIN_ROT = 7, PIN_INC = 8;   // pan / tilt
const uint8_t PIN_CVG = 9, PIN_CVD = 10;
// Ultrason HC-SR04 : les seules broches encore libres. D3/5/6/11 sont prises
// par les moteurs, D4 active les ponts, D7 a D10 portent les quatre servos.
// Vcc du module sur le 5V : c'est un composant 5 V, et Echo ressort en 5 V —
// direct sur l'Arduino, sans pont diviseur (il en faudrait un vers le Pi).
const uint8_t PIN_TRIG = 12, PIN_ECHO = 2;
// Radar de presence LD2410 : seule sa sortie OUT est utilisee (etat haut =
// presence). Sa liaison serie donnerait la distance et l'energie, mais elle
// tourne a 256000 bauds, hors de portee d'un SoftwareSerial — et l'unique
// UART materiel de l'Arduino est pris par le Pi. L'etat haut/bas suffit.
// Sa logique est en 3,3 V : l'Arduino lit cela comme un niveau haut (seuil
// a ~3,0 V), pas besoin d'adaptation.
const uint8_t PIN_PRESENCE = 13;

Servo s_rot, s_inc, s_cvg, s_cvd;

// Vitesse de croisiere, 0 a 255. 255 = plein PWM, c'est-a-dire toute la
// tension de la batterie aux moteurs. Rien au-dessus n'existe : pour aller
// plus vite il faudrait changer de moteurs, de reducteur ou de batterie.
int vitesse = 255;

// --- Equilibrage (trim) ---
//
// Deux moteurs du meme modele, au meme PWM, ne tournent JAMAIS exactement a
// la meme vitesse : tolerances, frottement du reducteur, usure, pertes dans
// les fils. 5 a 10 % d'ecart est normal, et le robot part en crabe.
//
// On ne peut que RALENTIR le cote rapide, jamais accelerer le lent : a 255 on
// est deja au plafond du PWM, il n'y a aucune marge au-dessus. On paie donc
// la ligne droite avec un peu de vitesse maximale.
//
// Bornes a 0..100 volontairement : au-dela, v * trim deborderait un int sur
// AVR (255 * 200 = 51000 > 32767) et le moteur partirait n'importe comment.
//
// Le Pi impose ces valeurs a la connexion (MOTOR_TRIM_LEFT / _RIGHT dans le
// service), donc tu ajustes sans jamais reflasher.
int trim_g = 100;   // % appliques au cote gauche
int trim_d = 100;   // % appliques au cote droit

// --- Demarrage progressif (marche avant et arriere UNIQUEMENT) ---
//
// A 255 d'emblee, le moteur qui repond le premier fait pivoter le chassis
// avant que les autres n'aient pris : le robot part de travers a chaque
// depart, et les roues patinent. On monte donc la puissance en ~0,3 s.
//
// Les VIRAGES n'ont deliberement pas de rampe : c'est la manoeuvre qui
// demande le plus de couple, et sur un sol accrocheur une montee douce
// laisserait le robot planter sans tourner. Idem pour le stop, qui doit
// rester immediat — c'est une securite.
//
// J<n> regle le PWM de depart depuis le Pi, sans reflasher. Plus il est bas,
// plus le depart est doux ET plus la rampe est longue (le pas est fixe).
int rampe_depart = 120;          // PWM au premier instant du depart
const uint8_t RAMPE_PAS = 8;     // increment par palier
const uint8_t RAMPE_MS = 20;     // duree d'un palier
int8_t marche = 0;               // +1 avant, -1 arriere, 0 = pas en rampe
int niveau = 0;                  // PWM courant pendant la montee
uint32_t t_rampe = 0;

// ---------------- roues ----------------
void cote(uint8_t rpwm, uint8_t lpwm, int v) {
  v = constrain(v, -255, 255);
  if (v >= 0) { analogWrite(lpwm, 0); analogWrite(rpwm,  v); }
  else        { analogWrite(rpwm, 0); analogWrite(lpwm, -v); }
}
void roues(int g, int d) {
  // Division entiere : elle tronque vers zero, ce qui convient ici (on ne
  // veut jamais qu'un arrondi transforme un 0 en mouvement).
  if (G_INVERT) g = -g;
  if (D_INVERT) d = -d;
  cote(G_RPWM, G_LPWM, g * trim_g / 100);
  cote(D_RPWM, D_LPWM, d * trim_d / 100);
}

// Pilotage differentiel : chaque cote recoit un pourcentage de la vitesse
// courante. C'est ce qui permet le virage en ARC (tourner en avancant), et
// c'est aussi par la que passe le maintien de cap automatique.
//
// Pourquoi l'arc compte : en rotation pure, les pneus doivent riper en
// travers du sol ; en arc ils ROULENT. La resistance s'effondre, et c'est
// exactement ce qui rend les virages difficiles sur certains revetements.
//
// (long) avant la multiplication : 255 * 100 tient dans un int, mais de
// justesse (25500 sur 32767). Un jour ou vitesse et le pourcentage montent,
// ca deborderait en silence et le moteur partirait n'importe comment.
void mix(int pg, int pd) {
  pg = constrain(pg, -100, 100);
  pd = constrain(pd, -100, 100);
  roues((long)vitesse * pg / 100, (long)vitesse * pd / 100);
}

// Lance ou poursuit une marche avant/arriere.
// L'app repete l'ordre toutes les ~400 ms tant que le doigt est sur le
// bouton : il ne faut donc PAS repartir du debut a chaque repetition, sinon
// la rampe se reinitialiserait en boucle et le robot n'accelererait jamais.
// On ne (re)demarre que si le sens change.
void demarrer(int8_t sens) {
  if (marche != sens) {
    marche = sens;
    niveau = min(rampe_depart, vitesse);
    t_rampe = millis();
  }
  roues(sens * niveau, sens * niveau);
}

void rampe_gerer() {
  if (!marche || niveau >= vitesse) return;
  if (millis() - t_rampe < RAMPE_MS) return;
  t_rampe = millis();
  niveau += RAMPE_PAS;
  if (niveau > vitesse) niveau = vitesse;
  roues(marche * niveau, marche * niveau);
}

// ---------------- couvercle ----------------
// Regroupe ici pour que les deux servos bougent toujours ensemble et en
// sens opposes : ils se font face, l'un doit reculer quand l'autre avance.
void couvercle(bool ouvert) {
  if (ouvert) { s_cvg.write(160); s_cvd.write(20);  }
  else        { s_cvg.write(20);  s_cvd.write(160); }
}

// ---------------- tourelle ----------------
// Butees logicielles, conformes a la geometrie verifiee du pan/tilt :
// l'inclinaison est libre de -60 a +60 deg autour de l'horizontale
// (soit 30 a 150), on garde 10 deg de marge. La rotation est libre sur
// 360 deg mecaniquement, ce sont les fils qui limitent.
const int ROT_MIN = 10, ROT_MAX = 170;
const int INC_MIN = 40, INC_MAX = 140;      // 90 = camera a l'horizontale
int cible_rot = 90, cible_inc = 90, pos_rot = 90, pos_inc = 90;
void tourelle_gerer() {
  static uint32_t t = 0;
  if (millis() - t < 15) return;
  t = millis();
  if (pos_rot < cible_rot) pos_rot++; else if (pos_rot > cible_rot) pos_rot--;
  if (pos_inc < cible_inc) pos_inc++; else if (pos_inc > cible_inc) pos_inc--;
  s_rot.write(pos_rot); s_inc.write(pos_inc);
}

// ---------------- presence (radar LD2410) ----------------
//
// On n'envoie QUE les changements d'etat, pas un flot continu : le Pi n'a
// besoin de savoir que "ca vient de passer a occupe" ou "c'est redevenu vide".
//
// Confirmation sur 3 lectures espacees de 50 ms : la sortie du radar est
// propre, mais un parasite sur un fil de 20 cm a cote de quatre moteurs, ca
// existe. Meme principe que partout ailleurs ici — jamais agir sur une mesure
// isolee.
int presenceEtat = -1;        // -1 = inconnu au demarrage
int presenceCandidat = -1;
uint8_t presenceCompte = 0;
uint32_t t_presence = 0;
uint32_t t_presenceRappel = 0;

void presence_gerer() {
  if (millis() - t_presence < 50) return;
  t_presence = millis();
  const int lu = digitalRead(PIN_PRESENCE) ? 1 : 0;
  if (lu != presenceCandidat) {
    presenceCandidat = lu;
    presenceCompte = 1;
    return;
  }
  if (presenceCompte < 3) presenceCompte++;
  if (presenceCompte < 3) return;
  // On renvoie l'etat sur CHANGEMENT, et aussi toutes les 30 s meme s'il n'a
  // pas bouge. Sans ce rappel, un radar bloque en detection permanente (il
  // traverse les cloisons et voit la piece d'a cote) n'emet plus rien du tout
  // — et devient indiscernable d'un capteur debranche. Le Pi doit toujours
  // savoir ce que le radar voit, pas seulement quand ca change.
  const bool change = (lu != presenceEtat);
  if (!change && millis() - t_presenceRappel < 30000) return;
  t_presenceRappel = millis();
  presenceEtat = lu;
  Serial.print(F("PRES:"));
  Serial.println(presenceEtat);
}

// ---------------- distance ----------------
//
// Une mesure par seconde, pas plus : chaque mesure bloque jusqu'a 25 ms en
// attendant l'echo, et pendant ce temps ni la rampe ni la tourelle
// n'avancent. A 1 Hz la saccade est invisible ; a 10 Hz elle ne le serait pas.
//
// 25 ms d'attente = environ 4 m de portee, largement au-dela de l'utile.
// Pas d'echo dans ce delai = rien devant (ou surface qui renvoie mal), on
// n'envoie alors aucune ligne plutot qu'une fausse distance.
uint32_t t_mesure = 0;

void distance_gerer() {
  // Scan toutes les secondes
  if (millis() - t_mesure < 1000) return;
  t_mesure = millis();

  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  unsigned long duree = pulseIn(PIN_ECHO, HIGH, 25000UL);
  if (duree==0) {
    pinMode(PIN_ECHO, OUTPUT);
    pinMode(PIN_ECHO, LOW);
    delay(100);
    pinMode(PIN_ECHO, INPUT);
  } else {
    long dist = duree * 17 / 100;               // vitesse du son, aller-retour
    if (dist < 2 || dist > 400) return;     // hors des limites du capteur
    Serial.print("0,0,0,0,");
    Serial.println(dist);
  }
  // Serial.print(F("D:"));
  // Serial.println(cm);
}

// ---------------- protocole ----------------
// Une commande = une lettre, suivie d'un nombre optionnel.
// On repond TOUJOURS ACK:<lettre>, meme si la lettre est inconnue :
// l'app ne doit jamais rester bloquee sur un timeout.
char    tampon[16];
uint8_t n = 0;
uint32_t dernier_ordre = 0, t_dernier_car = 0;

void identifier() { Serial.println(F("READY:rover_uart")); }

void executer(char *s) {
  char c = s[0];
  // atoi("") vaut 0 : sans ce garde-fou, un "P" tout seul enverrait la
  // tourelle en butee a 10 deg au lieu de ne rien faire — et un "V" tout
  // seul mettrait la vitesse a zero, ce qui immobilisait le rover.
  bool chiffre = (s[1] >= '0' && s[1] <= '9');
  int  a = atoi(s + 1);
  switch (c) {
    case 'F': demarrer(+1); break;                // avant, en progressif
    case 'B': demarrer(-1); break;                // arriere, en progressif
    // Virages et stop : pleine puissance tout de suite, aucune rampe.
    case 'L': marche = 0; roues(-vitesse,  vitesse); break;   // contre-rotation
    case 'R': marche = 0; roues( vitesse, -vitesse); break;   // contre-rotation
    case 'S': marche = 0; roues(0, 0); break;                 // stop general
    case 'V': if (chiffre) vitesse = constrain(a, 0, 255); break;
    // D / X ne servent plus : le mat est fixe. On ne les traite pas, mais
    // l'ACK part quand meme (voir plus bas) pour que l'app du Pi ne reste
    // jamais bloquee sur un timeout si elle les envoie encore.
    case 'P': if (chiffre) cible_rot = constrain(a, ROT_MIN, ROT_MAX); break;
    // 'U' est ce qu'envoie robot.js, 'T' etait l'ancien nom : on prend les
    // deux, ca evite d'avoir a synchroniser les deux cotes.
    case 'U':
    case 'T': if (chiffre) cible_inc = constrain(a, INC_MIN, INC_MAX); break;
    case 'C': cible_rot = 90; cible_inc = 90; break;   // recentrer la camera
    case 'O': couvercle(true);  break;                 // couvercle ouvert
    case 'K': couvercle(chiffre && a != 0); break;     // K1 ouvre, K0 ferme
    case 'G': if (chiffre) trim_g = constrain(a, 0, 100); break;
    case 'H': if (chiffre) trim_d = constrain(a, 0, 100); break;
    case 'J': if (chiffre) rampe_depart = constrain(a, 0, 255); break;
    case 'M': {
      // Deux nombres SIGNES separes par une virgule : atoi ne suffit plus.
      char *p = s + 1;
      long pg = strtol(p, &p, 10);
      if (*p == ',') {
        long pd = strtol(p + 1, NULL, 10);
        marche = 0;          // pilotage direct : on sort de la rampe
        mix((int)pg, (int)pd);
      }
      break;
    }
    case 'I': identifier(); break;
  }
  Serial.print(F("ACK:")); Serial.println(c);
  dernier_ordre = millis();
}

void setup() {
  pinMode(EN_PONTS, OUTPUT); digitalWrite(EN_PONTS, LOW);
  const uint8_t p[4] = { G_RPWM, G_LPWM, D_RPWM, D_LPWM };
  for (uint8_t i = 0; i < 4; i++) { pinMode(p[i], OUTPUT); analogWrite(p[i], 0); }
  s_rot.attach(PIN_ROT); s_rot.write(pos_rot);
  s_inc.attach(PIN_INC); s_inc.write(pos_inc);
  s_cvg.attach(PIN_CVG); s_cvd.attach(PIN_CVD);
  couvercle(false);
  pinMode(PIN_TRIG, OUTPUT);
  digitalWrite(PIN_TRIG, LOW);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_PRESENCE, INPUT);
  Serial.begin(9600);                 // MEME VITESSE QUE L'APP
  digitalWrite(EN_PONTS, HIGH);
  identifier();
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    t_dernier_car = millis();
    if (c == '\n' || c == '\r') {
      if (n) { tampon[n] = 0; executer(tampon); n = 0; }
    } else if (n < sizeof(tampon) - 1) {
      tampon[n++] = c;
    }
  }
  // Si l'app envoie la lettre SANS retour a la ligne, on traite quand
  // meme au bout de 60 ms de silence. Comme ca le sketch marche dans
  // les deux cas, avec ou sans terminaison de ligne.
  if (n && millis() - t_dernier_car > 60) { tampon[n] = 0; executer(tampon); n = 0; }

  // Securite : plus d'ordre depuis 1,5 s, on coupe ce qui bouge.
  // On remet aussi la rampe a zero, pour que le prochain depart reparte
  // bien en douceur au lieu d'attaquer a la vitesse ou on s'etait arrete.
  if (millis() - dernier_ordre > 1500) { marche = 0; roues(0, 0); }

  rampe_gerer();
  tourelle_gerer();
  distance_gerer();
  presence_gerer();
}
