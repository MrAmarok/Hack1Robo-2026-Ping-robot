// withFmtFix.js - Config plugin Expo
//
// Corrige l'erreur de compilation du pod `fmt` (utilise par React Native)
// avec Xcode 26 / clang recent :
//   "call to consteval function 'fmt::basic_format_string<...>' is not a
//    constant expression"
//
// fmt active le mot-cle C++20 `consteval` quand le compilateur le supporte
// (FMT_USE_CONSTEVAL=1). Le clang d'Xcode 26 rejette l'usage que fait fmt de
// FMT_STRING. On force FMT_USE_CONSTEVAL=0 : fmt redefinit alors FMT_CONSTEVAL
// comme vide et le code compile.
//
// IMPORTANT : on insere le correctif A LA FIN du bloc post_install, APRES
// l'appel `react_native_post_install(...)` d'Expo. Sinon cet appel reecrit les
// build settings des pods et efface notre define (cause du 1er echec).
// On applique le define a TOUTES les cibles par securite (inoffensif pour les
// pods qui n'utilisent pas fmt).

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = 'FMT_USE_CONSTEVAL=0';

const FMT_SNIPPET = `  # --- withFmtFix: corrige fmt + Xcode 26 (consteval) ---
  installer.pods_project.targets.each do |fmtfix_target|
    fmtfix_target.build_configurations.each do |fmtfix_config|
      defs = fmtfix_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']
      defs = [defs] if defs.is_a?(String)
      defs << '${MARKER}' unless defs.include?('${MARKER}')
      fmtfix_config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = defs
      flags = fmtfix_config.build_settings['OTHER_CPLUSPLUSFLAGS'] || ['$(inherited)']
      flags = [flags] if flags.is_a?(String)
      flags << '-D${MARKER}' unless flags.include?('-D${MARKER}')
      fmtfix_config.build_settings['OTHER_CPLUSPLUSFLAGS'] = flags
    end
  end
  # Patch direct des sources fmt (au cas ou le define ne se propage pas) :
  # on supprime le mot-cle consteval de la macro FMT_CONSTEVAL.
  fmtfix_count = 0
  Dir.glob(File.join(installer.sandbox.root.to_s, 'fmt', '**', '*.h')).each do |fmtfix_h|
    fmtfix_txt = File.read(fmtfix_h)
    if fmtfix_txt.include?('define FMT_CONSTEVAL consteval')
      File.write(fmtfix_h, fmtfix_txt.gsub('define FMT_CONSTEVAL consteval', 'define FMT_CONSTEVAL /* fmtfix: neutralise */'))
      fmtfix_count += 1
    end
  end
  puts "[withFmtFix] post_install applique (define + #{fmtfix_count} header(s) fmt patches)"
  # --- fin withFmtFix ---`;

function patchPodfile(contents) {
  if (contents.includes(MARKER)) return contents; // deja applique

  const lines = contents.split('\n');
  const startIdx = lines.findIndex((l) => /post_install do \|installer\|/.test(l));

  if (startIdx === -1) {
    // Aucun post_install : on en ajoute un complet a la fin.
    return (
      contents.replace(/\s*$/, '') +
      `\n\npost_install do |installer|\n${FMT_SNIPPET}\nend\n`
    );
  }

  // Trouver le `end` qui ferme le bloc post_install en suivant la profondeur
  // des blocs imbriques (`... do |x|` ouvre, `end` ferme). On part a 1 pour le
  // `do` du post_install lui-meme.
  let endIdx = -1;
  let depth = 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/\bdo\b/.test(line)) depth++;
    if (/^\s*end\b/.test(line)) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) {
    // Securite : si on ne trouve pas le end, on ajoute un bloc separe.
    return (
      contents.replace(/\s*$/, '') +
      `\n\npost_install do |installer|\n${FMT_SNIPPET}\nend\n`
    );
  }

  lines.splice(endIdx, 0, FMT_SNIPPET);
  return lines.join('\n');
}

module.exports = withFmtFix;
module.exports.patchPodfile = patchPodfile; // expose pour tests

function withFmtFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      const before = fs.readFileSync(podfile, 'utf8');
      const after = patchPodfile(before);
      fs.writeFileSync(podfile, after);
      // Trace visible dans les logs de prebuild EAS pour confirmer l'application.
      console.log(
        after.includes(MARKER)
          ? '[withFmtFix] Podfile patche (FMT_USE_CONSTEVAL=0) ✅'
          : '[withFmtFix] ATTENTION: patch non applique ❌'
      );
      return cfg;
    },
  ]);
};
