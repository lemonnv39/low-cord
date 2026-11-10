# low-cord — données du correcteur (AutoCorrect)

`fr-ngrams.bin.gz` : fréquences des mots et des paires de mots du français
parlé, utilisées par le plugin AutoCorrect pour choisir le mot le plus
probable entre ses voisins (« saluts » → « salut », « tu va » → « tu vas »).

- Source : corpus OpenSubtitles 2018 (OPUS), 45 millions de lignes de
  sous-titres français, soit 267 millions de mots.
  P. Lison et J. Tiedemann, « OpenSubtitles2016: Extracting Large Parallel
  Corpora from Movie and TV Subtitles », LREC 2016 — https://opus.nlpl.eu/
- Contenu : uniquement des comptes agrégés (150 000 mots, 4,6 millions de
  paires vues au moins deux fois). Aucune phrase du corpus n'y figure.
- Construit avec `build.mjs` (même dossier), qui lit le corpus en flux.

Format : voir l'en-tête de `build.mjs`. Le plugin télécharge ce fichier à un
commit précis et le refuse si son empreinte sha256 diffère.
