// Test autonome moteurs - aucune commande serie necessaire.
// Televerse ce sketch, pose le robot roues en l'air:
// il teste automatiquement les canaux moteur un par un.
//
// L298N principal:
// ENA -> D5,  IN1 -> D6,  IN2 -> D7
// ENB -> D10, IN3 -> D8,  IN4 -> D9
//
// Si tu as un 2e L298N:
// ENA -> D11, IN1 -> D12, IN2 -> D13
// ENB -> A0,  IN3 -> A1,  IN4 -> A2

struct MotorPins {
  int en;
  int inA;
  int inB;
  const char* name;
};

const MotorPins FRONT_LEFT  = {5,  6,  7,  "FRONT_LEFT"};
const MotorPins FRONT_RIGHT = {10, 8,  9,  "FRONT_RIGHT"};
const MotorPins REAR_LEFT   = {11, 12, 13, "REAR_LEFT"};
const MotorPins REAR_RIGHT  = {A0, A1, A2, "REAR_RIGHT"};

const int SPEED = 255;

void setupMotor(MotorPins m) {
  pinMode(m.en, OUTPUT);
  pinMode(m.inA, OUTPUT);
  pinMode(m.inB, OUTPUT);
}

void motor(MotorPins m, int dir, int spd) {
  analogWrite(m.en, spd);
  digitalWrite(m.inA, dir > 0 ? HIGH : LOW);
  digitalWrite(m.inB, dir < 0 ? HIGH : LOW);
}

void stopMotor(MotorPins m) {
  analogWrite(m.en, 0);
  digitalWrite(m.inA, LOW);
  digitalWrite(m.inB, LOW);
}

void stopAll() {
  stopMotor(FRONT_LEFT);
  stopMotor(FRONT_RIGHT);
  stopMotor(REAR_LEFT);
  stopMotor(REAR_RIGHT);
}

void testMotor(MotorPins m) {
  Serial.print("TEST ");
  Serial.println(m.name);
  stopAll();
  delay(500);
  motor(m, 1, SPEED);
  delay(2500);
  stopAll();
  delay(1000);
}

void setup() {
  Serial.begin(9600);
  setupMotor(FRONT_LEFT);
  setupMotor(FRONT_RIGHT);
  setupMotor(REAR_LEFT);
  setupMotor(REAR_RIGHT);
  stopAll();
  Serial.println("READY:direct_motor_auto_test");
}

void loop() {
  testMotor(FRONT_LEFT);
  testMotor(FRONT_RIGHT);
  testMotor(REAR_LEFT);
  testMotor(REAR_RIGHT);
}
