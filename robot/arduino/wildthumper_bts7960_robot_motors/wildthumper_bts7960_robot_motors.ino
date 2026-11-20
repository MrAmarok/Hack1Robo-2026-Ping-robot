// Chassis skid-steer 4 roues - 2x BTS7960 (HW-039) + pan-tilt camera (2 servos)
//
// NOTE : le dossier s'appelle encore "wildthumper_bts7960" et l'en-tete
// d'origine annoncait 6 roues. Le chassis en a QUATRE (2 par cote, confirme
// le 17/09/2026). Sans consequence sur le code : les moteurs d'un meme cote
// sont en parallele sur un seul driver, leur nombre n'entre nulle part.
// Meme protocole serie que robot_motors.ino (Elegoo), adapte au driver BTS7960.
//
// !!! CABLAGE MODIFIE POUR LES SERVOS !!!
// Servo.h prend le Timer1 de l'Uno -> analogWrite ne marche PLUS sur D9/D10.
// Le fil D_LPWM (arriere droit) a donc DEMENAGE de D9 vers D11,
// et les servos du pan-tilt recuperent D9 (pan) et D10 (tilt).
//
// Cablage moteurs (BTS7960 : chaque cote a un RPWM et un LPWM):
//   Cote gauche : G_RPWM D3, G_LPWM D5    (avant = RPWM, arriere = LPWM)
//   Cote droit  : D_RPWM D6, D_LPWM D11   (avant = RPWM, arriere = LPWM)
//   (Astuce BTS7960 : relier R_EN et L_EN au +5V, sinon les mettre a HIGH au setup)
//   HC-SR04 (optionnel) : Echo A4, Trig A5
//
// Cablage pan-tilt (servos SG90/MG90S de la camera Innomaker):
//   Servo pan (gauche/droite)  : signal D9
//   Servo tilt (haut/bas)      : signal D10
//   Alimentation servos : 5V EXTERNE (UBEC/BEC), PAS le 5V de l'Arduino
//   (2 servos qui forcent = pics >1A = reset Arduino). Masses communes !
//
// Commandes serie 9600 (envoyees par robot.js):
//   F avancer, B reculer, L gauche, R droite, S stop
//   + accelerer, - ralentir
//   V<n> vitesse absolue (ex "V180"), bornee MIN_SPEED..MAX_SPEED
//   P<n> pan camera (angle 0..180, ex "P90")
//   U<n> tilt camera (angle 0..180, borne TILT_MIN..TILT_MAX)
//   C    recentre la camera (pan 90 / tilt 90)
//   1 teste gauche, 2 teste droit, T avance 1.5s puis stop

#include <Servo.h>

// --- Pins moteurs ---
const int G_RPWM = 3;
const int G_LPWM = 5;
const int D_RPWM = 6;
const int D_LPWM = 11;  // etait D9, deplace a cause de Servo.h (Timer1)

// --- Pan-tilt camera ---
const int SERVO_PAN_PIN = 9;
const int SERVO_TILT_PIN = 10;
// Si la camera part dans le mauvais sens quand tu appuies sur une fleche
// de l'app, passe l'invert correspondant a true (pas besoin de recabler).
const bool PAN_INVERT = false;
const bool TILT_INVERT = false;
const int PAN_MIN = 0,  PAN_MAX = 180;
const int TILT_MIN = 20, TILT_MAX = 160; // evite que la camera tape le support
// Mouvement adouci : on glisse vers l'angle demande par petits pas
// (video plus fluide + pas de pic de courant qui ferait rebooter l'Arduino).
// Detachement au repos. Un servo attache tient sa position en permanence :
// il vibre, chauffe et consomme pour rien. Detache, il est tenu par la
// demultiplication de ses pignons — largement suffisant pour une camera.
// Surtout, tant qu'aucune commande n'est arrivee il reste MOU : plus de
// sursaut a pleine force au branchement.
// 0 = ne jamais detacher (le servo resiste alors aux vibrations du chassis).
const unsigned long SERVO_IDLE_MS = 1500;
const int SERVO_STEP = 3;                 // degres par tick
const unsigned long SERVO_TICK_MS = 15;   // un tick toutes les 15 ms

Servo servoPan;
Servo servoTilt;
int panTarget = 90, panCurrent = 90;
int tiltTarget = 90, tiltCurrent = 90;
unsigned long lastServoTick = 0;
bool servosAttached = false;        // attaches seulement quand ils doivent bouger
unsigned long servosStillSince = 0; // depuis quand ils sont arrives a destination

// Sens des moteurs : si un cote tourne a l'envers quand on envoie F,
// passe son "invert" a true, re-televerse, et il repart dans le bon sens.
const bool G_INVERT = false;   // cote gauche
const bool D_INVERT = true;    // cote droit (inverse : il reculait quand le gauche avancait)

const int ECHO_PIN = A4;
const int TRIG_PIN = A5;

// --- Facon de tourner ---
//
// false = virage PIVOT : un cote a l'arret, l'autre avance. Le chassis tourne
//   autour des roues arretees. Sur un skid-steer a pneus accrocheurs c'est le
//   pire des cas : la MOITIE des roues doit etre trainee en travers, et elles
//   freinent plus fort que les autres ne poussent. Le robot force, chauffe,
//   et ne tourne pas.
//
// true = virage SUR PLACE (contre-rotation) : un cote avance pendant que
//   l'autre recule. Les six roues sont motrices, le chassis pivote autour de
//   son centre au lieu de devoir glisser lateralement. C'est la facon normale
//   de faire tourner un engin a skid-steer.
//
// A savoir : la consommation monte nettement (tous les moteurs en charge au
// lieu de la moitie). Avec une batterie faible, c'est la que ca s'effondre.
const bool SPIN_TURN = true;

const int MIN_SPEED = 140;
const int MAX_SPEED = 255;
const int SPEED_STEP = 35;
int currentSpeed = 255;   // vitesse de depart au MAX (255 = plein PWM)
char currentAction = 'S';

unsigned long lastPing = 0;
unsigned long lastMotionCommand = 0;
const unsigned long MOTION_TIMEOUT_MS = 900;

// Lecture d'un nombre apres V (vitesse), P (pan) ou U (tilt).
// readingNumFor = la lettre en cours, numAcc = -1 tant qu'aucun chiffre recu.
char readingNumFor = 0;
int numAcc = -1;

// Sur BTS7960 : avant -> RPWM = vitesse, LPWM = 0 ; arriere -> l'inverse.
void setLeft(int direction, int speed) {
  if (G_INVERT) direction = -direction;
  if (direction > 0) {
    analogWrite(G_RPWM, speed);
    analogWrite(G_LPWM, 0);
  } else if (direction < 0) {
    analogWrite(G_RPWM, 0);
    analogWrite(G_LPWM, speed);
  } else {
    analogWrite(G_RPWM, 0);
    analogWrite(G_LPWM, 0);
  }
}

void setRight(int direction, int speed) {
  if (D_INVERT) direction = -direction;
  if (direction > 0) {
    analogWrite(D_RPWM, speed);
    analogWrite(D_LPWM, 0);
  } else if (direction < 0) {
    analogWrite(D_RPWM, 0);
    analogWrite(D_LPWM, speed);
  } else {
    analogWrite(D_RPWM, 0);
    analogWrite(D_LPWM, 0);
  }
}

void stopMotors() {
  currentAction = 'S';
  setLeft(0, 0);
  setRight(0, 0);
}

void forward() {
  currentAction = 'F';
  lastMotionCommand = millis();
  setLeft(1, currentSpeed);
  setRight(1, currentSpeed);
}

void backward() {
  currentAction = 'B';
  lastMotionCommand = millis();
  setLeft(-1, currentSpeed);
  setRight(-1, currentSpeed);
}

void turnLeft() {
  currentAction = 'L';
  lastMotionCommand = millis();
  // setLeft/setRight appliquent eux-memes G_INVERT et D_INVERT : on raisonne
  // ici en sens LOGIQUE (1 = vers l'avant du robot, -1 = vers l'arriere).
  setLeft(SPIN_TURN ? -1 : 0, SPIN_TURN ? currentSpeed : 0);
  setRight(1, currentSpeed);
}

void turnRight() {
  currentAction = 'R';
  lastMotionCommand = millis();
  setLeft(1, currentSpeed);
  setRight(SPIN_TURN ? -1 : 0, SPIN_TURN ? currentSpeed : 0);
}

void applyCurrentAction() {
  switch (currentAction) {
    case 'F': forward(); break;
    case 'B': backward(); break;
    case 'L': turnLeft(); break;
    case 'R': turnRight(); break;
    default: break;
  }
}

void changeSpeed(int delta) {
  currentSpeed += delta;
  if (currentSpeed < MIN_SPEED) currentSpeed = MIN_SPEED;
  if (currentSpeed > MAX_SPEED) currentSpeed = MAX_SPEED;
  Serial.print("SPEED:");
  Serial.println(currentSpeed);
  applyCurrentAction();
}

void testForward() {
  Serial.println("ACK:T");
  forward();
  delay(1500);
  stopMotors();
}

void writePan(int angle) {
  servoPan.write(PAN_INVERT ? 180 - angle : angle);
}

void writeTilt(int angle) {
  servoTilt.write(TILT_INVERT ? 180 - angle : angle);
}

// Attache a la demande. Appele avant tout mouvement, jamais dans setup() :
// attach() commande 1500 us (90 deg) des la premiere impulsion, ce qui faisait
// se jeter les servos a l'allumage.
void servosOn() {
  if (servosAttached) return;
  servoPan.attach(SERVO_PAN_PIN);
  servoTilt.attach(SERVO_TILT_PIN);
  // Repart de la position memorisee, pas du 90 deg par defaut d'attach().
  writePan(panCurrent);
  writeTilt(tiltCurrent);
  servosAttached = true;
}

void servosOff() {
  if (!servosAttached) return;
  servoPan.detach();
  servoTilt.detach();
  servosAttached = false;
}

// Glisse pan et tilt vers leur angle cible, SERVO_STEP degres a la fois,
// puis relache les servos une fois arrives (voir SERVO_IDLE_MS).
void servoTick() {
  if (millis() - lastServoTick < SERVO_TICK_MS) return;
  lastServoTick = millis();
  const bool bouge = (panCurrent != panTarget) || (tiltCurrent != tiltTarget);
  if (bouge) {
    servosOn();
    servosStillSince = 0;
  } else {
    // Arrives : on laisse le servo finir sa course, puis on relache.
    if (SERVO_IDLE_MS > 0 && servosAttached) {
      if (servosStillSince == 0) servosStillSince = millis();
      else if (millis() - servosStillSince > SERVO_IDLE_MS) servosOff();
    }
    return;
  }
  if (panCurrent != panTarget) {
    int d = panTarget - panCurrent;
    panCurrent += (d > 0) ? min(d, SERVO_STEP) : max(d, -SERVO_STEP);
    writePan(panCurrent);
  }
  if (tiltCurrent != tiltTarget) {
    int d = tiltTarget - tiltCurrent;
    tiltCurrent += (d > 0) ? min(d, SERVO_STEP) : max(d, -SERVO_STEP);
    writeTilt(tiltCurrent);
  }
}

long readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long dur = pulseIn(ECHO_PIN, HIGH, 30000);
  if (dur == 0) return -1;
  return dur / 58;
}

void setup() {
  pinMode(G_RPWM, OUTPUT);
  pinMode(G_LPWM, OUTPUT);
  pinMode(D_RPWM, OUTPUT);
  pinMode(D_LPWM, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // PAS d'attach ici : les servos restent mous tant qu'aucune commande n'est
  // arrivee. Ils s'attachent tout seuls au premier P/U/C (voir servosOn).

  Serial.begin(9600);
  stopMotors();
  Serial.println("READY:wildthumper_bts7960_pantilt");
  Serial.print("SPEED:");
  Serial.println(currentSpeed);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c -= 32;

    // Suite de chiffres apres un 'V', 'P' ou 'U' : on accumule le nombre.
    if (readingNumFor) {
      if (c >= '0' && c <= '9') {
        if (numAcc < 0) numAcc = 0;
        numAcc = numAcc * 10 + (c - '0');
        if (numAcc > 999) numAcc = 999;
        continue;
      }
      // Fin du nombre (newline ou autre) -> applique la valeur bornee.
      char forCmd = readingNumFor;
      readingNumFor = 0;
      if (numAcc >= 0) {
        if (forCmd == 'V' && numAcc > 0) {
          currentSpeed = constrain(numAcc, MIN_SPEED, MAX_SPEED);
          Serial.print("ACK:V");
          Serial.println(currentSpeed);
          applyCurrentAction();
        } else if (forCmd == 'P') {
          panTarget = constrain(numAcc, PAN_MIN, PAN_MAX);
          Serial.print("ACK:P");
          Serial.println(panTarget);
        } else if (forCmd == 'U') {
          tiltTarget = constrain(numAcc, TILT_MIN, TILT_MAX);
          Serial.print("ACK:U");
          Serial.println(tiltTarget);
        }
      }
      // c continue vers le switch normal (souvent un simple '\n').
    }

    switch (c) {
      case 'V':
      case 'P':
      case 'U': readingNumFor = c; numAcc = -1; break;
      case 'C':
        panTarget = 90;
        tiltTarget = 90;
        Serial.println("ACK:C");
        break;
      case 'F': Serial.println("ACK:F"); forward(); break;
      case 'B': Serial.println("ACK:B"); backward(); break;
      case 'L': Serial.println("ACK:L"); turnLeft(); break;
      case 'R': Serial.println("ACK:R"); turnRight(); break;
      case 'S': Serial.println("ACK:S"); stopMotors(); break;
      case '+': Serial.println("ACK:+"); changeSpeed(SPEED_STEP); break;
      case '-': Serial.println("ACK:-"); changeSpeed(-SPEED_STEP); break;
      case 'T': testForward(); break;
      // lastMotionCommand DOIT etre arme, sinon le SAFE_STOP ci-dessous se
      // declenche des la boucle suivante et le test ne dure que quelques
      // microsecondes — invisible a l'oeil (constate le 07/08).
      case '1':
        Serial.println("ACK:1 LEFT");
        currentAction = 'L'; lastMotionCommand = millis();
        setLeft(1, currentSpeed); setRight(0, 0);
        break;
      case '2':
        Serial.println("ACK:2 RIGHT");
        currentAction = 'R'; lastMotionCommand = millis();
        setLeft(0, 0); setRight(1, currentSpeed);
        break;
      default: break;
    }
  }

  servoTick();

  if (currentAction != 'S' && millis() - lastMotionCommand > MOTION_TIMEOUT_MS) {
    Serial.println("SAFE_STOP");
    stopMotors();
  }

  if (millis() - lastPing > 1000) {
    lastPing = millis();
    long d = readDistanceCm();
    if (d > 0) {
      Serial.print("D:");
      Serial.println(d);
    }
  }
}
