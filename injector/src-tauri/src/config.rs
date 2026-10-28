/*
 * Constantes de distribution low-cord — le owner/repo GitHub est défini ICI
 * une seule fois (et dans cord/src/lowcord/constants.ts côté cord).
 *
 * Monorepo public : la dist du cord vit sur la branche orpheline `builds`
 * (écrite par .github/workflows/cord.yml), l'exe de l'injecteur dans les
 * GitHub Releases (tags `injector-v*`, .github/workflows/injector-release.yml).
 */

pub const BUILD_BASE_URL: &str = "https://raw.githubusercontent.com/lemonnv39/low-cord/builds";
pub const COMMITS_API_URL: &str = "https://api.github.com/repos/lemonnv39/low-cord/commits/builds";
pub const RELEASES_API: &str = "https://api.github.com/repos/lemonnv39/low-cord/releases/latest";

/// Préfixe des tags de release de l'injecteur (monorepo : le cord n'a pas de releases).
pub const RELEASE_TAG_PREFIX: &str = "injector-v";

/// Dossier sous %APPDATA% (identique au DATA_DIR du cord, voir cord/src/main/utils/constants.ts).
pub const DATA_DIR_NAME: &str = "low-cord";

pub const USER_AGENT: &str = "low-cord-injector";
