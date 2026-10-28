# low-cord

> par **shitday**

Client mod Discord **open source** pour un cercle restreint d'utilisateurs —
un fork minimal de [Vencord](https://github.com/Vendicated/Vencord) + son
injecteur Windows portable. Tout le code est ici, rien n'est caché.

Pas de spam, pas de raid : juste un client propre et stable.

## Installer

1. Télécharge `low-cord-injector.exe` depuis la
   [dernière Release](https://github.com/lemonnv39/low-cord/releases/latest).
2. Lance-le, clique **Installer** sur ta version de Discord (Stable / PTB / Canary).
3. Discord redémarre : la catégorie **low-cord** apparaît dans les paramètres.

L'injecteur se met à jour tout seul, et récupère toujours la dernière build du
cord à l'installation.

## Ce que fait l'injecteur, exactement

- Sauvegarde le vrai `resources\app.asar` de Discord en `_app.asar`
  (après avoir vérifié que c'est bien l'original, jamais un stub).
- Remplace `app.asar` par un petit stub (2 fichiers) qui charge
  `%APPDATA%\low-cord\dist\patcher.js`.
- Télécharge la dist (4 fichiers) depuis la branche
  [`builds`](https://github.com/lemonnv39/low-cord/tree/builds) de ce repo,
  construite par la CI à partir des sources de `cord/`.
- Si un autre mod (Vencord, Equicord, Abyss…) est présent, il restaure d'abord
  le Discord d'origine puis installe low-cord à la place.
- **Désinstaller** restaure `_app.asar` → Discord redevient vanilla.

## Où sont les fichiers

| Quoi | Où |
|---|---|
| Dist du cord | `%APPDATA%\low-cord\dist\` |
| Réglages du cord (plugins…) | `%APPDATA%\low-cord\settings\settings.json` |
| Stub injecté | `%LOCALAPPDATA%\Discord\app-X.Y.Z\resources\app.asar` |
| Discord d'origine sauvegardé | `…\resources\_app.asar` |

## Structure du repo

```
cord/       fork de Vencord (git subtree) — nos ajouts sont isolés :
            src/lowcord/            branding + onglet de réglages
            src/lowplugins/         nos plugins (vide pour l'instant)
            scripts/build/lowcord.mjs  filtre : quels plugins sont embarqués
injector/   injecteur Tauri v2 (Rust + Svelte 5), exe portable
.github/    CI : build du cord → branche builds ; check + release de l'injecteur
```

### Plugins

Le pack de départ est **vide** : seuls le cœur de Vencord (`_api`, `_core`)
et `cord/src/lowplugins/` sont embarqués. Les ~150 plugins d'origine de
Vencord restent dans l'arbre (pour récupérer les correctifs upstream sans
conflit) mais ne sont pas compilés — voir `VENCORD_PLUGINS_ALLOWLIST` dans
`cord/scripts/build/lowcord.mjs`.

### Mettre à jour la base Vencord

```bash
git subtree pull --prefix=cord https://github.com/Vendicated/Vencord main --squash
```

### Publier

- **Cord** : tout push sur `main` qui touche `cord/` → la CI type-check, lint,
  build et publie la dist sur `builds`.
- **Injecteur** : aligner la version dans `injector/package.json`,
  `injector/src-tauri/Cargo.toml` et `injector/src-tauri/tauri.conf.json`,
  puis pousser un tag `injector-vX.Y.Z` → Release publique avec l'exe.

## Licence

GPL-3.0-or-later, comme Vencord dont ce projet est dérivé.
