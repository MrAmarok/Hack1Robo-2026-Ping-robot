// Test 4 roues avec 2 modules L298N.
//
// L298N #1 (avant):
// ENA -> D9,  IN1 -> D8, IN2 -> D7   = FRONT_LEFT
// ENB -> D3,  IN3 -> D5, IN4 -> D4   = FRONT_RIGHT
//
// L298N #2 (arriere):
// ENA -> D11, IN1 -> D12, IN2 -> D13 = REAR_LEFT
// ENB -> D6,  IN3 -> A1,  IN4 -> A2  = REAR_RIGHT
//
// GND Arduino -> GND des 2 L298N -> GND batterie moteur

struct MotorPins {
  int en;
  int inA;
  int inB;
  bool invert;
  const char* name;
};

const MotorPins FRONT_LEFT  = {9,  8,  7,  false, "FRONT_LEFT"};
const MotorPins FRONT_RIGHT = {3,  5,  4,  true,  "FRONT_RIGHT"};
const MotorPins REAR_LEFT   = {11, 12, 13, false, "REAR_LEFT"};
const MotorPins REAR_RIGHT  = {6,  A1, A2, true,  "REAR_RIGHT"};

const int SPEED = 255;

void setupMotor(MotorPins m) {
  pinMode(m.en, OUTPUT);
  pinMode(m.inA, OUTPUT);
  pinMode(m.inB, OUTPUT);
}

void motor(MotorPins m, int dir, int spd) {
  if (m.invert) dir = -dir;
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

void forward() {
  motor(FRONT_LEFT, 1, SPEED);
  motor(FRONT_RIGHT, 1, SPEED);
  motor(REAR_LEFT, 1, SPEED);
  motor(REAR_RIGHT, 1, SPEED);
}

void backward() {
  motor(FRONT_LEFT, -1, SPEED);
  motor(FRONT_RIGHT, -1, SPEED);
  motor(REAR_LEFT, -1, SPEED);
  motor(REAR_RIGHT, -1, SPEED);
}

void turnLeft() {
  motor(FRONT_LEFT, 0, 0);
  motor(REAR_LEFT, 0, 0);
  motor(FRONT_RIGHT, 1, SPEED);
  motor(REAR_RIGHT, 1, SPEED);
}

void turnRight() {
  motor(FRONT_LEFT, 1, SPEED);
  motor(REAR_LEFT, 1, SPEED);
  motor(FRONT_RIGHT, 0, 0);
  motor(REAR_RIGHT, 0, 0);
}

void testOne(MotorPins m) {
  stopAll();
  Serial.print("ACK:");
  Serial.println(m.name);
  motor(m, 1, SPEED);
}

void setup() {
  Serial.begin(9600);
  setupMotor(FRONT_LEFT);
  setupMotor(FRONT_RIGHT);
  setupMotor(REAR_LEFT);
  setupMotor(REAR_RIGHT);
  stopAll();
  Serial.println("READY:two_l298n_4wheels_test");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c -= 32;

    switch (c) {
      case 'F': Serial.println("ACK:F"); forward(); break;
      case 'B': Serial.println("ACK:B"); backward(); break;
      case 'L': Serial.println("ACK:L"); turnLeft(); break;
      case 'R': Serial.println("ACK:R"); turnRight(); break;
      case 'S': Serial.println("ACK:S"); stopAll(); break;
      case '1': testOne(FRONT_LEFT); break;
      case '2': testOne(FRONT_RIGHT); break;
      case '3': testOne(REAR_LEFT); break;
      case '4': testOne(REAR_RIGHT); break;
      default: break;
    }
  }
}
