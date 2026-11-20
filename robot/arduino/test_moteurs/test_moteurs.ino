// test_moteurs.ino - Diagnostic des moteurs, SANS le Raspberry Pi.
//
// A televerser a la place du sketch normal quand un moteur ne repond plus.
// Tout se pilote depuis le moniteur serie de l'IDE Arduino, a 9600 bauds
// (menu deroulant en bas a droite : "9600 baud" et "Nouvelle ligne").
//
// Pourquoi tester CANAL PAR CANAL plutot que "avance / recule" :
// chaque BTS7960 contient DEUX demi-ponts, un par sens de rotation. Si un
// seul est grille, le moteur tourne dans un sens et pas dans l'autre — et un
// test "avance" seul conclurait a tort que tout va bien. Les commandes 1 a 4
// activent donc une seule sortie a la fois.
//
// Cablage attendu (identique au sketch de production) :
//   Cote gauche : G_RPWM D3  (avant)   G_LPWM D5   (arriere)
//   Cote droit  : D_RPWM D6  (avant)   D_LPWM D11  (arriere)
//   BTS7960 : R_EN et L_EN au +5V
//   L'alimentation de PUISSANCE des BTS7960 vient de la batterie, pas de
//   l'Arduino. Sans elle, ce sketch tournera sans qu'aucune roue ne bouge.
//
// SECURITE : rien ne demarre tout seul. Chaque test dure 2 secondes puis
// s'arrete, et la barre d'espace (ou 'S') coupe tout immediatement.

const int G_RPWM = 3;   // gauche, sens avant
const int G_LPWM = 5;   // gauche, sens arriere
const int D_RPWM = 6;   // droit, sens avant
const int D_LPWM = 11;  // droit, sens arriere

const int PINS[4] = { G_RPWM, G_LPWM, D_RPWM, D_LPWM };
const char* NOMS[4] = {
  "D3  G_RPWM  gauche AVANT",
  "D5  G_LPWM  gauche ARRIERE",
  "D6  D_RPWM  droit  AVANT",
  "D11 D_LPWM  droit  ARRIERE",
};

int vitesse = 200;                  // 0-255. 200 = franc sans etre brutal.
const unsigned long DUREE_MS = 2000; // duree d'un test

void toutArreter() {
  for (int i = 0; i < 4; i++) analogWrite(PINS[i], 0);
}

void menu() {
  Serial.println();
  Serial.println(F("=== TEST MOTEURS ==="));
  Serial.print(F("Vitesse actuelle : "));
  Serial.println(vitesse);
  Serial.println(F("--- un seul canal a la fois (localise la panne) ---"));
  for (int i = 0; i < 4; i++) {
    Serial.print(F("  "));
    Serial.print(i + 1);
    Serial.print(F(" -> "));
    Serial.println(NOMS[i]);
  }
  Serial.println(F("--- par cote (les deux sens a la suite) ---"));
  Serial.println(F("  G -> tout le cote GAUCHE"));
  Serial.println(F("  D -> tout le cote DROIT"));
  Serial.println(F("  A -> sequence complete, les 4 canaux"));
  Serial.println(F("--- divers ---"));
  Serial.println(F("  + / -  vitesse    S  stop immediat"));
  Serial.println();
}

// Active UNE sortie pendant DUREE_MS, en annoncant ce qui doit se passer.
void testerCanal(int index) {
  toutArreter();
  Serial.println();
  Serial.print(F("--> "));
  Serial.print(NOMS[index]);
  Serial.print(F("   pendant "));
  Serial.print(DUREE_MS / 1000);
  Serial.println(F("s"));
  Serial.println(F("    (regarde QUELLES roues tournent et dans quel sens)"));

  analogWrite(PINS[index], vitesse);
  unsigned long t0 = millis();
  while (millis() - t0 < DUREE_MS) {
    // Coupure immediate si on tape S pendant le test.
    if (Serial.available()) {
      char c = Serial.read();
      if (c == 'S' || c == 's' || c == ' ') {
        toutArreter();
        Serial.println(F("    ARRET demande."));
        return;
      }
    }
  }
  toutArreter();
  Serial.println(F("    fini."));
}

void testerCote(bool gauche) {
  if (gauche) {
    testerCanal(0);
    delay(600);
    testerCanal(1);
  } else {
    testerCanal(2);
    delay(600);
    testerCanal(3);
  }
}

void setup() {
  for (int i = 0; i < 4; i++) {
    pinMode(PINS[i], OUTPUT);
    analogWrite(PINS[i], 0);
  }
  Serial.begin(9600);
  delay(300);
  Serial.println();
  Serial.println(F("Pret. Rien ne bougera tant que tu n'auras rien tape."));
  menu();
}

void loop() {
  if (!Serial.available()) return;
  char c = Serial.read();

  switch (c) {
    case '1': testerCanal(0); menu(); break;
    case '2': testerCanal(1); menu(); break;
    case '3': testerCanal(2); menu(); break;
    case '4': testerCanal(3); menu(); break;
    case 'G': case 'g': testerCote(true);  menu(); break;
    case 'D': case 'd': testerCote(false); menu(); break;
    case 'A': case 'a':
      for (int i = 0; i < 4; i++) { testerCanal(i); delay(600); }
      menu();
      break;
    case '+':
      vitesse = min(255, vitesse + 25);
      Serial.print(F("vitesse = ")); Serial.println(vitesse);
      break;
    case '-':
      vitesse = max(60, vitesse - 25);
      Serial.print(F("vitesse = ")); Serial.println(vitesse);
      break;
    case 'S': case 's': case ' ':
      toutArreter();
      Serial.println(F("STOP."));
      break;
    default: break; // ignore les retours a la ligne
  }
}
