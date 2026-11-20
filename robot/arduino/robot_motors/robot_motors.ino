// ELEGOO Smart Robot Car Kit V3.0 - L298N
// Reference V3:
//   ENA D5, IN1 D7, IN2 D8   = cote gauche / canal A
//   ENB D6, IN3 D9, IN4 D11  = cote droit / canal B
//   HC-SR04: Echo A4, Trig A5
//
// Commandes serie 9600:
//   F avancer, B reculer, L gauche, R droite, S stop
//   + accelerer, - ralentir
//   V<n> vitesse absolue (ex "V180"), bornee MIN_SPEED..MAX_SPEED
//   1 teste gauche, 2 teste droit, T avance 1.5s puis stop

const int ENA = 5;
const int IN1 = 7;
const int IN2 = 8;
const int ENB = 6;
const int IN3 = 9;
const int IN4 = 11;

const int ECHO_PIN = A4;
const int TRIG_PIN = A5;

// --- Facon de tourner ---
//
// false = virage PIVOT : un cote a l'arret, l'autre avance. Le chassis tourne
//   autour des roues arretees. Sur un chassis a pneus accrocheurs c'est le
//   pire des cas : la MOITIE des roues doit etre trainee en travers, et elles
//   freinent plus fort que les autres ne poussent. Le robot force, chauffe,
//   et ne tourne pas. C'est exactement le symptome constate le 17/09/2026.
//
// true = virage SUR PLACE (contre-rotation) : un cote avance pendant que
//   l'autre recule. Toutes les roues sont motrices, le chassis pivote autour
//   de son centre au lieu de devoir glisser lateralement.
//
// A savoir : la consommation monte (tous les moteurs en charge au lieu de la
// moitie). Avec une batterie faible, c'est la que la tension s'effondre.
const bool SPIN_TURN = true;

const int MIN_SPEED = 140;
const int MAX_SPEED = 255;
const int SPEED_STEP = 35;
int currentSpeed = 255;   // vitesse de depart au MAX (255 = plein PWM)
char currentAction = 'S';

// Lecture d'un nombre qui suit une lettre de commande (ex "V180").
// readingNumFor = la lettre en cours, numAcc = -1 tant qu'aucun chiffre recu.
char readingNumFor = 0;
int numAcc = -1;

unsigned long lastPing = 0;
unsigned long lastMotionCommand = 0;
const unsigned long MOTION_TIMEOUT_MS = 900;

void setLeft(int direction, int speed) {
  if (direction > 0) {
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
  } else if (direction < 0) {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, HIGH);
  } else {
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
  }
  analogWrite(ENA, direction == 0 ? 0 : speed);
}

void setRight(int direction, int speed) {
  // Sur le V3 officiel, l'avant du cote droit est IN3 LOW / IN4 HIGH.
  if (direction > 0) {
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, HIGH);
  } else if (direction < 0) {
    digitalWrite(IN3, HIGH);
    digitalWrite(IN4, LOW);
  } else {
    digitalWrite(IN3, LOW);
    digitalWrite(IN4, LOW);
  }
  analogWrite(ENB, direction == 0 ? 0 : speed);
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
  pinMode(ENA, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  Serial.begin(9600);
  stopMotors();
  Serial.println("READY:elegoo_v3_l298n");
  Serial.print("SPEED:");
  Serial.println(currentSpeed);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c -= 32;

    // Suite de chiffres apres un 'V' : on accumule le nombre.
    // Sans ce bloc, "V180" etait lu comme quatre caracteres inconnus et
    // ignore en silence : le curseur de vitesse de l'app ne faisait RIEN, et
    // les ralentissements demandes par le serveur pendant l'asservissement
    // visuel (V150) ne prenaient pas non plus.
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
      if (forCmd == 'V' && numAcc > 0) {
        currentSpeed = constrain(numAcc, MIN_SPEED, MAX_SPEED);
        Serial.print("ACK:V");
        Serial.println(currentSpeed);
        applyCurrentAction();
      }
      // c continue vers le switch normal (souvent un simple '\n').
    }

    switch (c) {
      case 'V': readingNumFor = c; numAcc = -1; break;
      case 'F': Serial.println("ACK:F"); forward(); break;
      case 'B': Serial.println("ACK:B"); backward(); break;
      case 'L': Serial.println("ACK:L"); turnLeft(); break;
      case 'R': Serial.println("ACK:R"); turnRight(); break;
      case 'S': Serial.println("ACK:S"); stopMotors(); break;
      case '+': Serial.println("ACK:+"); changeSpeed(SPEED_STEP); break;
      case '-': Serial.println("ACK:-"); changeSpeed(-SPEED_STEP); break;
      case 'T': testForward(); break;
      case '1': Serial.println("ACK:1 LEFT"); currentAction = 'L'; setLeft(1, currentSpeed); setRight(0, 0); break;
      case '2': Serial.println("ACK:2 RIGHT"); currentAction = 'R'; setLeft(0, 0); setRight(1, currentSpeed); break;
      default: break;
    }
  }

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
