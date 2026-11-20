// find_pins.ino — CHERCHEUR DE BROCHES (diagnostic câblage moteurs)
// ---------------------------------------------------------------------------
// Teste toutes les paires (ENABLE, DIRECTION) parmi les broches 5,6,7,8,9,10.
// Pour chaque paire : annonce "[index] EN=x DIR=y" sur le moniteur série
// (9600 bauds), active 1,5 s, puis pause.
//
// >>> TON BOULOT : note l'INDEX quand une roue tourne, + QUELLE roue + QUEL SENS.
//     Exemple :  "[3] -> roue gauche tourne en avant"
//
// (Si AUCUNE des 30 combinaisons ne bouge une roue, on élargira la recherche.)

const int pins[] = {5, 6, 7, 8, 9, 10};
const int N = 6;

void allLow() {
  for (int i = 0; i < N; i++) {
    pinMode(pins[i], OUTPUT);
    digitalWrite(pins[i], LOW);
  }
}

void setup() {
  Serial.begin(9600);
  allLow();
  Serial.println("=== CHERCHEUR DE BROCHES (paires EN/DIR sur 5,6,7,8,9,10) ===");
  delay(2000);
}

void loop() {
  int idx = 1;
  for (int e = 0; e < N; e++) {
    for (int d = 0; d < N; d++) {
      if (e == d) continue;
      allLow();
      Serial.print("[");
      Serial.print(idx);
      Serial.print("] EN=");
      Serial.print(pins[e]);
      Serial.print("  DIR=");
      Serial.println(pins[d]);
      analogWrite(pins[e], 255); // enable à fond
      digitalWrite(pins[d], HIGH);
      delay(1500);
      allLow();
      delay(800);
      idx++;
    }
  }
  Serial.println("--- fin du cycle, ca recommence dans 4s ---");
  delay(4000);
}
