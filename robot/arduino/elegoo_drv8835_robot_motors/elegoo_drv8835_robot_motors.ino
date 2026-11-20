// Test moteurs Wild Thumper 6WD - 2x BTS7960 (HW-039)
// Gauche
// TEST : on échange les broches gauche et droite
const int G_RPWM = 3;
const int G_LPWM = 5;
const int D_RPWM = 6;
const int D_LPWM = 9;

void setup() {
  pinMode(G_RPWM, OUTPUT);
  pinMode(G_LPWM, OUTPUT);
  pinMode(D_RPWM, OUTPUT);
  pinMode(D_LPWM, OUTPUT);
  arret();
  delay(3000);   // 3s de pause avant de démarrer, le temps de poser le robot
}

void avancer(int v) {          // v = vitesse 0-255
  analogWrite(G_RPWM, v);  analogWrite(G_LPWM, 0);
  analogWrite(D_RPWM, v);  analogWrite(D_LPWM, 0);
}

void reculer(int v) {
  analogWrite(G_RPWM, 0);  analogWrite(G_LPWM, v);
  analogWrite(D_RPWM, 0);  analogWrite(D_LPWM, v);
}

void arret() {
  analogWrite(G_RPWM, 0);  analogWrite(G_LPWM, 0);
  analogWrite(D_RPWM, 0);  analogWrite(D_LPWM, 0);
}

void loop() {
  avancer(100);   // vitesse douce pour le 1er test
  delay(2000);
  arret();
  delay(1500);
  reculer(100);
  delay(2000);
  arret();
  delay(1500);
}