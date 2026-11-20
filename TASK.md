# À avoir

- Fonctionnalité de la ronde
- Module d'alarme à poser et coder

## Tâches

- Vérifier le fonctionnement de la collision
- Synchronisation des plans 2D (récupérer les données de parcours afin de créer une carte initiale)
- Traiter le signal reçu et bloquer le robot en cas d'obstacle initial

## Récupération des données

- Connecter le module au robot
- Récupération des données brutes (raw)

## Traitement des données

- Conversion des données brutes en distance via des ondes ultrasonores ($40\text{ kHz}$)
- Distance \* 0.032 / 2

## Carte

- Création de la carte 2D (génération du plan par superposition des éléments reçus par le capteur)

## Ordres programmables

- Chaîne d'actions
- Conditions d'arrêt automatique
