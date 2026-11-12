# Compte rendu — revue de low-cord par Fable 5.2 (12/11/2026)

Sauvegarde de l'état d'avant : tag `sauvegarde-avant-fable` et branche `sauvegarde/avant-fable`.
Pour revenir en arrière : `git reset --hard sauvegarde-avant-fable`.

Cinq commits, dans l'ordre : `b04766a2`, `03485bc4`, `4e4b3917`, `47cadf79`, puis ce compte rendu.

## Avant / après

| Sujet | Avant | Maintenant |
|---|---|---|
| **MessageLogger — messages perdus après un clear MP** | Un nettoyage supprime de vieux messages que low-cord n'avait jamais chargés : ils partaient du journal sans contenu. | Le nettoyeur confie chaque page lue au journal avant de supprimer. C'était une des deux causes de la « faille invisible ». |
| **MessageLogger — messages rouges qui disparaissent** | Depuis le 10/11, la remise en place des messages supprimés plantait à chaque rechargement d'une conversation (177 erreurs dans tes logs Discord). | Corrigé : une variable `c` du patch entrait en collision avec celle de Discord. C'est la deuxième cause. |
| **Anti-clear (nouveau)** | Si quelqu'un vidait la conversation, seuls les messages déjà vus étaient gardés. | 3 suppressions à la suite dans un MP ou un groupe : low-cord copie tout l'historique restant, en partant des deux bouts. |
| **MP non lus (nouveau)** | Un message reçu Discord fermé puis supprimé avant ouverture était perdu. | Au démarrage, les derniers messages des MP non lus sont copiés. |
| **Noms des fichiers du journal** | `media\<id du salon>\<id>-<nom>` | `conversations\<pseudo> [<id>]\medias\<auteur> - <id> - <nom>`. L'ancien rangement est converti tout seul. |
| **Sauvegarde avant clear MP** | Aucune. | Export `.html` complet (moteur d'ExportMessages) rangé dans `conversations\<pseudo> [<id>]\sauvegardes\`. Si la sauvegarde échoue, rien n'est supprimé. Visible depuis le journal et l'historique du nettoyeur. Réglage dans MessageCleaner. |
| **Sécurité — médias archivés** | « Ouvrir » lançait le fichier, y compris un `.exe` reçu en pièce jointe. | Seuls les vrais médias s'ouvrent ; le reste est montré dans son dossier. |
| **Sécurité — mises à jour** | Fichiers téléchargés acceptés sans contrôle de contenu. | Chaque fichier doit avoir l'empreinte Git du commit publié (vérifié sur la vraie build). |
| **Mises à jour — retour arrière (nouveau)** | Une mauvaise mise à jour pouvait bloquer Discord chez tout le monde. | L'ancienne version est gardée ; après 3 démarrages ratés, elle est remise toute seule. |
| **Sécurité — plugins perso** | Un `.zip` pouvait se décompresser sans limite. | Taille contrôlée avant décompression. |
| **Patches cassés** | Couleurs de rôle absentes des réactions et des sondages ; mention d'un salon vocal caché. | Réparés. Les 74 patches sont vérifiés sur le build Discord complet (670026). |
| **Optimisation de Discord** | 3 réglages (animations, mode jeu, interface). | 4 de plus, qui changent le fonctionnement interne : voir ci-dessous. |
| **low-sound — latence** | Tampon rempli jusqu'à sa limite : environ 200 ms. | Réserve visée de 60 ms, tenue par un ajustement de vitesse de ±0,5 %. |
| **low-sound — volume** | Volume + limiteur à relâchement fixe (pompage sur les basses). | Réglage « Puissance » (cible LUFS) et limiteur à deux vitesses. |
| **low-sound — qualité** | Conversion 44,1 → 48 kHz par interpolation linéaire. | Filtre sinc : aigus intacts, pas de repliement. |
| **low-sound — filtres** | Coupe-bas 12 dB/oct. | Pente 12 / 24 / 48 dB/oct, coupe-haut, affichage LUFS. |

## Optimisation interne de Discord (onglet low-cord)

Discord désactive tout ce que Chromium fait pour une fenêtre en arrière-plan. Les nouveaux réglages :

- **Arrière-plan économe** : fenêtre réduite, plus aucun dessin (le vocal et les notifications continuent) ; fenêtre sans le focus, animations en pause ; après une minute, mémoire rendue.
- **Mémoire des conversations** : les salons non rouverts depuis 20 min sortent de la mémoire.
- **Processus allégés** (au redémarrage) : plus de processus de rendu de réserve.
- **Journal silencieux** : Discord n'écrit plus toute sa console dans un fichier, seulement les erreurs.
- Bouton **Libérer la mémoire**, avec le gain affiché.

Le « Mode optimisé » active tout. Rien n'est appliqué tant que le réglage est éteint.

## Ce qui a été vérifié, et ce qui ne l'a pas été

- Vérifié : la CI complète de cord à chaque lot, les 74 patches sur le vrai code Discord, le rangement du journal, le bouclier, le retour arrière et les options Chromium dans des bancs de test, 33 tests sur le traitement audio.
- **Pas testé dans Discord** : rien n'a tourné dans ton client. Le gain réel en mémoire et processeur n'est pas mesuré.
- **Moteur low-sound non compilé ici** : Visual Studio n'est plus installé sur ce PC. Le code passe le contrôle de types, clippy et rustfmt, mais c'est la CI GitHub qui produira l'exe 0.16.0. Le panneau demande cette version : tant qu'elle n'est pas publiée, il proposera une mise à jour du moteur.
- La variante GNU de Rust a été installée via rustup pour lancer les tests audio.

## Pas fait

- Les ajouts « carte blanche » au-delà de ceux listés (anti-clear, MP non lus, retour arrière, bouton mémoire).
- Blocage des quêtes et promotions de Discord (étudié, pas écrit).
- Revue en profondeur de MultiInstance, TokenImporter et AutoCorrect (lus en partie, rien d'alarmant trouvé).
- Améliorations du Mini APO.
