// Configuration Expo dynamique.
//
// app.json reste la source de verite : ce fichier le reprend tel quel et n'y
// ajoute que ce qui ne doit pas etre suivi par git — l'emplacement des
// fichiers Firebase et la cle Google Maps.
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
//
// Cle Google Maps : elle etait en dur dans app.json (trois fois). Elle vient
// maintenant de GOOGLE_MAPS_API_KEY — mobile/.env en local (Expo le charge
// avant ce fichier), variable d'environnement EAS pour les builds.
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';
if (!googleMapsApiKey) {
  console.warn(
    'GOOGLE_MAPS_API_KEY absente (mobile/.env ou variable EAS) : les cartes Google resteront vides.'
  );
}

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile,
    config: {
      ...config.android?.config,
      googleMaps: { ...config.android?.config?.googleMaps, apiKey: googleMapsApiKey },
    },
  },
  ios: {
    ...config.ios,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_PLIST || config.ios?.googleServicesFile,
    config: { ...config.ios?.config, googleMapsApiKey },
  },
  extra: { ...config.extra, googleMapsApiKey },
});
