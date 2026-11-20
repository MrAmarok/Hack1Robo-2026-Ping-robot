// Test L298N avec pins classiques.
// Cabler:
// ENA -> D9
// IN1 -> D8
// IN2 -> D7
// IN3 -> D5
// IN4 -> D4
// ENB -> D3
//
// OUT1/OUT2 -> cote gauche
// OUT3/OUT4 -> cote droit
// Batterie moteur + -> +12V/VIN L298N
// Batterie moteur - -> GND L298N
// GND Arduino -> GND L298N

const int ENA = 9;
const int IN1 = 8;
const int IN2 = 7;
const int IN3 = 5;
const int IN4 = 4;
const int ENB = 3;

const int SPEED = 255;

void motorA(int dir) {
  analogWrite(ENA, SPEED);
  digitalWrite(IN1, dir > 0 ? HIGH : LOW);
  digitalWrite(IN2, dir < 0 ? HIGH : LOW);
}

void motorB(int dir) {
  analogWrite(ENB, SPEED);
  digitalWrite(IN3, dir > 0 ? HIGH : LOW);
  digitalWrite(IN4, dir < 0 ? HIGH : LOW);
}

void stopAll() {
  analogWrite(ENA, 0);
  analogWrite(ENB, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);
}

void forward() {
  motorA(1);
  motorB(1);
}

void backward() {
  motorA(-1);
  motorB(-1);
}

void left() {
  motorA(0);
  motorB(1);
}

void right() {
  motorA(1);
  motorB(0);
}

void setup() {
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  pinMode(ENB, OUTPUT);

  Serial.begin(9600);
  stopAll();
  Serial.println("READY:l298n_common_pins_test");

  delay(1000);
  Serial.println("AUTO:F");
  forward();
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
      case 'S': Serial.println("ACK:S"); stopAll(); break;
      case '1': Serial.println("ACK:1 LEFT"); motorA(1); analogWrite(ENB, 0); break;
      case '2': Serial.println("ACK:2 RIGHT"); analogWrite(ENA, 0); motorB(1); break;
      default: break;
    }
  }
}
