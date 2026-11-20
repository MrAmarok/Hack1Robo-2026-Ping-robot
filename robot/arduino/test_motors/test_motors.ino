// test_motors.ino — Test AUTOMATIQUE des moteurs (diagnostic)
// ---------------------------------------------------------------------------
// Au démarrage, teste chaque roue SÉPARÉMENT, 2 secondes chacune, en
// annonçant ce qu'il fait sur le moniteur série (9600 bauds). Puis recommence.
//
// Objectif : voir EXACTEMENT quelle roue tourne à chaque phase.
// Mêmes broches que robot_motors.ino — adapte-les si besoin.

struct MotorPins {
  int en;
  int inA;
  int inB;
  bool invert;
};

// Mets invert=true si cette roue tourne a l'envers quand tu demandes AVANT.
const MotorPins FRONT_LEFT  = {5,  6,  7,  false};
const MotorPins FRONT_RIGHT = {10, 8,  9,  true};
const MotorPins REAR_LEFT   = {11, 12, 13, false};
const MotorPins REAR_RIGHT  = {A0, A1, A2, true};

const int SPEED = 255; // pleine puissance

void setupMotor(MotorPins m);
void writeSpeed(int pin, int spd);
void motor(MotorPins m, int dir, int spd);
void stopAll();
void phase(const char* texte, MotorPins m, int dir);

void setup() {
  setupMotor(FRONT_LEFT);
  setupMotor(FRONT_RIGHT);
  setupMotor(REAR_LEFT);
  setupMotor(REAR_RIGHT);
  Serial.begin(9600);
  Serial.println("=== TEST MOTEURS : chaque roue testee 2s ===");
}

void setupMotor(MotorPins m) {
  pinMode(m.en, OUTPUT);
  pinMode(m.inA, OUTPUT);
  pinMode(m.inB, OUTPUT);
}

void writeSpeed(int pin, int spd) {
  if (spd <= 0) {
    digitalWrite(pin, LOW);
  } else if (spd >= 255) {
    digitalWrite(pin, HIGH);
  } else {
    analogWrite(pin, spd);
  }
}

void motor(MotorPins m, int dir, int spd) {
  if (m.invert) dir = -dir;
  writeSpeed(m.en, spd);
  digitalWrite(m.inA, dir > 0);
  digitalWrite(m.inB, dir < 0);
}
void stopAll() {
  motor(FRONT_LEFT, 0, 0);
  motor(FRONT_RIGHT, 0, 0);
  motor(REAR_LEFT, 0, 0);
  motor(REAR_RIGHT, 0, 0);
}

void phase(const char* texte, MotorPins m, int dir) {
  Serial.println(texte);
  motor(m, dir, SPEED);
  delay(2000);
  stopAll();
  delay(1000);
}

void loop() {
  phase(">> AVANT GAUCHE en AVANT",    FRONT_LEFT,  1);
  phase(">> AVANT GAUCHE en ARRIERE",  FRONT_LEFT, -1);
  phase(">> ARRIERE GAUCHE en AVANT",  REAR_LEFT,   1);
  phase(">> ARRIERE GAUCHE en ARRIERE", REAR_LEFT,  -1);
  phase(">> AVANT DROITE en AVANT",    FRONT_RIGHT, 1);
  phase(">> AVANT DROITE en ARRIERE",  FRONT_RIGHT, -1);
  phase(">> ARRIERE DROITE en AVANT",  REAR_RIGHT,  1);
  phase(">> ARRIERE DROITE en ARRIERE", REAR_RIGHT, -1);
  Serial.println("--- fin du cycle, on recommence ---");
  delay(1500);
}
