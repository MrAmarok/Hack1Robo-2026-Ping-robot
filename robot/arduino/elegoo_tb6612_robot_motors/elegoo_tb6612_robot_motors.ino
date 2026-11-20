// ELEGOO Smart Robot Car Kit V4.0 - moteur TB6612
// Pins d'origine trouvees dans le code ELEGOO:
// PWMA D5  = moteur A / cote droit
// PWMB D6  = moteur B / cote gauche
// AIN  D7  = direction cote droit
// BIN  D8  = direction cote gauche
// STBY D3  = activation driver
//
// Commandes serie:
// F avancer, B reculer, L gauche, R droite, S stop
// 1 teste cote gauche, 2 teste cote droit, T avance 1.5s puis stop

const int PIN_Motor_PWMA = 5; // Right speed
const int PIN_Motor_PWMB = 6; // Left speed
const int PIN_Motor_AIN_1 = 7; // Right direction
const int PIN_Motor_BIN_1 = 8; // Left direction
const int PIN_Motor_STBY = 3; // Driver enable

const int TRIG = 13;
const int ECHO = 12;

const int MIN_SPEED = 90;
const int MAX_SPEED = 255;
const int SPEED_STEP = 25;
int currentSpeed = 200;
char currentAction = 'S';

unsigned long lastPing = 0;

void setRight(bool forward, int speed) {
  digitalWrite(PIN_Motor_STBY, HIGH);
  digitalWrite(PIN_Motor_AIN_1, forward ? HIGH : LOW);
  analogWrite(PIN_Motor_PWMA, speed);
}

void setLeft(bool forward, int speed) {
  digitalWrite(PIN_Motor_STBY, HIGH);
  digitalWrite(PIN_Motor_BIN_1, forward ? HIGH : LOW);
  analogWrite(PIN_Motor_PWMB, speed);
}

void stopMotors() {
  currentAction = 'S';
  analogWrite(PIN_Motor_PWMA, 0);
  analogWrite(PIN_Motor_PWMB, 0);
  digitalWrite(PIN_Motor_STBY, LOW);
}

void forward() {
  currentAction = 'F';
  setRight(true, currentSpeed);
  setLeft(true, currentSpeed);
}

void backward() {
  currentAction = 'B';
  setRight(false, currentSpeed);
  setLeft(false, currentSpeed);
}

void turnLeft() {
  currentAction = 'L';
  setRight(true, currentSpeed);
  analogWrite(PIN_Motor_PWMB, 0);
}

void turnRight() {
  currentAction = 'R';
  setLeft(true, currentSpeed);
  analogWrite(PIN_Motor_PWMA, 0);
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
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long dur = pulseIn(ECHO, HIGH, 30000);
  if (dur == 0) return -1;
  return dur / 58;
}

void setup() {
  pinMode(PIN_Motor_PWMA, OUTPUT);
  pinMode(PIN_Motor_PWMB, OUTPUT);
  pinMode(PIN_Motor_AIN_1, OUTPUT);
  pinMode(PIN_Motor_BIN_1, OUTPUT);
  pinMode(PIN_Motor_STBY, OUTPUT);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);

  Serial.begin(9600);
  stopMotors();
  Serial.println("READY:elegoo_tb6612_robot_motors");
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
      case 'S': Serial.println("ACK:S"); stopMotors(); break;
      case '+': Serial.println("ACK:+"); changeSpeed(SPEED_STEP); break;
      case '-': Serial.println("ACK:-"); changeSpeed(-SPEED_STEP); break;
      case 'T': testForward(); break;
      case '1': Serial.println("ACK:1 LEFT"); currentAction = 'L'; setLeft(true, currentSpeed); analogWrite(PIN_Motor_PWMA, 0); break;
      case '2': Serial.println("ACK:2 RIGHT"); currentAction = 'R'; setRight(true, currentSpeed); analogWrite(PIN_Motor_PWMB, 0); break;
      default: break;
    }
  }

  if (millis() - lastPing > 200) {
    lastPing = millis();
    long d = readDistanceCm();
    if (d > 0) {
      Serial.print("D:");
      Serial.println(d);
    }
  }
}
