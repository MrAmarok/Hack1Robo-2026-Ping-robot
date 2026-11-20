// Sketch robot final base sur le test qui a fait tourner les 4 roues.
// Mapping valide chez toi:
//   Gauche: PWM D6 + DIR D7 HIGH
//   Droite: PWM D5 + DIR D8 LOW
//
// Commandes:
//   F avancer, B reculer, L gauche, R droite, S stop
//   1 gauche seule, 2 droite seule

const int RIGHT_PWM = 5;
const int LEFT_PWM = 6;
const int LEFT_DIR = 7;

const int RIGHT_DIR_D8 = 8;
const int RIGHT_DIR_D9 = 9;

const int SPEED = 255;

void stopAll() {
  analogWrite(RIGHT_PWM, 0);
  analogWrite(LEFT_PWM, 0);
}

void leftForward() {
  digitalWrite(LEFT_DIR, HIGH);
  analogWrite(LEFT_PWM, SPEED);
}

void rightForward() {
  digitalWrite(LEFT_DIR, HIGH);
  digitalWrite(RIGHT_DIR_D8, LOW);
  digitalWrite(RIGHT_DIR_D9, LOW);
  analogWrite(RIGHT_PWM, SPEED);
}

void leftBackward() {
  digitalWrite(LEFT_DIR, LOW);
  analogWrite(LEFT_PWM, SPEED);
}

void rightBackward() {
  digitalWrite(LEFT_DIR, HIGH);
  digitalWrite(RIGHT_DIR_D8, HIGH);
  digitalWrite(RIGHT_DIR_D9, LOW);
  analogWrite(RIGHT_PWM, SPEED);
}

void forward() {
  leftForward();
  rightForward();
}

void backward() {
  leftBackward();
  rightBackward();
}

void turnLeft() {
  analogWrite(LEFT_PWM, 0);
  rightForward();
}

void turnRight() {
  leftForward();
  analogWrite(RIGHT_PWM, 0);
}

void setup() {
  pinMode(RIGHT_PWM, OUTPUT);
  pinMode(LEFT_PWM, OUTPUT);
  pinMode(LEFT_DIR, OUTPUT);
  pinMode(RIGHT_DIR_D8, OUTPUT);
  pinMode(RIGHT_DIR_D9, OUTPUT);

  Serial.begin(9600);
  stopAll();
  Serial.println("READY:elegoo_right_side_finder_FINAL");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c -= 32;

    switch (c) {
      case '1':
        Serial.println("ACK:1 LEFT D6+D7");
        stopAll();
        leftForward();
        break;

      case '2':
        Serial.println("ACK:2 RIGHT");
        stopAll();
        rightForward();
        break;

      case 'F':
        Serial.println("ACK:F");
        stopAll();
        backward();
        break;

      case 'B':
        Serial.println("ACK:B");
        stopAll();
        forward();
        break;

      case 'L':
        Serial.println("ACK:L");
        stopAll();
        turnLeft();
        break;

      case 'R':
        Serial.println("ACK:R");
        stopAll();
        turnRight();
        break;

      case 'S':
        Serial.println("ACK:S");
        stopAll();
        break;

      default:
        break;
    }
  }
}
