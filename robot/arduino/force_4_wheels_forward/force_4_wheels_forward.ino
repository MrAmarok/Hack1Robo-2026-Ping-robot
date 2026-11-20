// Force 4 roues en avant au demarrage.
// A utiliser pour revenir a un test simple: pas de GPS, pas de Raspberry,
// pas de commande serie necessaire.

const int FL_EN = 5;
const int FL_A = 6;
const int FL_B = 7;

const int FR_EN = 10;
const int FR_A = 8;
const int FR_B = 9;

const int RL_EN = 11;
const int RL_A = 12;
const int RL_B = 13;

const int RR_EN = A0;
const int RR_A = A1;
const int RR_B = A2;

void setupMotor(int en, int a, int b) {
  pinMode(en, OUTPUT);
  pinMode(a, OUTPUT);
  pinMode(b, OUTPUT);
}

void motorForward(int en, int a, int b, bool invert) {
  digitalWrite(en, HIGH);
  digitalWrite(a, invert ? LOW : HIGH);
  digitalWrite(b, invert ? HIGH : LOW);
}

void motorStop(int en, int a, int b) {
  digitalWrite(en, LOW);
  digitalWrite(a, LOW);
  digitalWrite(b, LOW);
}

void allForward() {
  motorForward(FL_EN, FL_A, FL_B, false);
  motorForward(FR_EN, FR_A, FR_B, true);
  motorForward(RL_EN, RL_A, RL_B, false);
  motorForward(RR_EN, RR_A, RR_B, true);
}

void allStop() {
  motorStop(FL_EN, FL_A, FL_B);
  motorStop(FR_EN, FR_A, FR_B);
  motorStop(RL_EN, RL_A, RL_B);
  motorStop(RR_EN, RR_A, RR_B);
}

void setup() {
  Serial.begin(9600);

  setupMotor(FL_EN, FL_A, FL_B);
  setupMotor(FR_EN, FR_A, FR_B);
  setupMotor(RL_EN, RL_A, RL_B);
  setupMotor(RR_EN, RR_A, RR_B);

  Serial.println("READY:force_4_wheels_forward");
  delay(1000);
  Serial.println("FORWARD");
  allForward();
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'S' || c == 's') {
      Serial.println("STOP");
      allStop();
    }
    if (c == 'F' || c == 'f') {
      Serial.println("FORWARD");
      allForward();
    }
  }
}
