// Configuration Expo dynamique.
//
// app.json reste la source de verite : ce fichier le reprend tel quel et ne
// change qu'une chose — l'emplacement des fichiers Firebase.
//
// Pourquoi : EAS Build ne televerse QUE les fichiers suivis par git, et
// google-services.json est volontairement exclu. Le build Android echouait donc
// avec « ENOENT: google-services.json », alors que le fichier existe bel et
// bien sur le poste.
//
// La solution officielle est de le fournir en variable d'environnement de type
// fichier : EAS l'ecrit sur le disque du constructeur et met son chemin dans
// GOOGLE_SERVICES_JSON. En local cette variable n'existe pas, donc on retombe
// sur le chemin d'app.json et rien ne change pour les commandes habituelles.
//
// Sans google-services.json, pas de Firebase Cloud Messaging — donc aucune
// notification push sur Android. Ce n'est pas un fichier optionnel ici.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile,
  },
  ios: {
    ...config.ios,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_PLIST || config.ios?.googleServicesFile,
  },
});
