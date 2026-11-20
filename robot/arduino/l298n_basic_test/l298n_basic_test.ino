// Test minimal L298N + Arduino
// Branchements:
// ENA -> D5,  IN1 -> D6, IN2 -> D7
// ENB -> D10, IN3 -> D8, IN4 -> D9
// Commandes serie:
// F/B/L/R/S = robot complet
// 1 = canal A/gauche seul, 2 = canal B/droit seul

const int ENA = 5;
const int IN1 = 6;
const int IN2 = 7;
const int ENB = 10;
const int IN3 = 8;
const int IN4 = 9;

const int SPEED = 255;

void setMotorA(int dir, int spd) {
  analogWrite(ENA, spd);
  digitalWrite(IN1, dir > 0 ? HIGH : LOW);
  digitalWrite(IN2, dir < 0 ? HIGH : LOW);
}

void setMotorB(int dir, int spd) {
  analogWrite(ENB, spd);
  digitalWrite(IN3, dir > 0 ? HIGH : LOW);
  digitalWrite(IN4, dir < 0 ? HIGH : LOW);
}

void stopMotors() {
  setMotorA(0, 0);
  setMotorB(0, 0);
}

void forward() {
  setMotorA(1, SPEED);
  setMotorB(1, SPEED);
}

void backward() {
  setMotorA(-1, SPEED);
  setMotorB(-1, SPEED);
}

void left() {
  setMotorA(0, 0);
  setMotorB(1, SPEED);
}

void right() {
  setMotorA(1, SPEED);
  setMotorB(0, 0);
}

void setup() {
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENB, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  Serial.begin(9600);
  stopMotors();
  Serial.println("READY:l298n_basic_test");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c -= 32;

    switch (c) {
      case 'F': Serial.println("ACK:F"); forward(); break;
      case 'B': Serial.println("ACK:B"); backward(); break;
      case 'L': Serial.println("ACK:L"); left(); break;
      case 'R': Serial.println("ACK:R"); right(); break;
      case 'S': Serial.println("ACK:S"); stopMotors(); break;
      case '1': Serial.println("ACK:1 MOTOR_A"); setMotorA(1, SPEED); setMotorB(0, 0); break;
      case '2': Serial.println("ACK:2 MOTOR_B"); setMotorA(0, 0); setMotorB(1, SPEED); break;
      default: break;
    }
  }
}
