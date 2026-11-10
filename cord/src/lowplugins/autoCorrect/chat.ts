/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — fautes typiques du chat que Grammalecte ne voit pas (il lit
// du français écrit, pas « tes ou ? » ni « je men fou »). Chaque règle est
// étroite : un contexte précis, sinon rien n'est touché.

export interface ChatSpeller {
    getMorph(word: string): string[];
}

export interface ChatFix {
    from: string;
    to: string;
}

type Rule = [RegExp, (m: RegExpExecArray) => string | null];

// Limites de mot qui comprennent les lettres accentuées (\b ne les voit pas).
const B = "(?<![\\p{L}\\d_'’])";
const W = "(?![\\p{L}'’])";
const hasTag = (morph: string[], tag: string) => morph.some(m => m.includes(tag));

/** Garde la majuscule du début (« Tes » → « T'es »). */
function caseLike(orig: string, to: string) {
    return orig[0] && orig[0] !== orig[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to;
}

// Début de phrase, ou après un petit mot de liaison du chat.
const START = "(^|[.!?…]\\s+|\\n|(?<![\\p{L}\\d_'’])(?:mais|et|bah|ben|wsh|wesh|frr|mdr|ptdr|si|quand|genre|bon|ah|oh|eh|tkt|non|oui|ouais)\\s+)";

const C_EST_NEXT = "pas|trop|bon|bien|mort|chaud|ouf|vrai|nul|grave|normal|ça|ca|quoi|qui|pour|comme|moi|toi|lui|cool|génial|genial|fini|bizarre|chiant|marrant|drôle|drole|dingue|fou|clair|sûr|sur|possible|mieux|pire|incroyable|magnifique|beau|joli|lourd|relou|chelou|une|un";
const T_ES_NEXT = "ou|où|con|conne|chiant|chiante|ouf|qui|là|la|sérieux|serieux|sérieuse|serieuse|bête|bete|nul|nulle|beau|belle|fou|folle|grave|sûr|sur|sure|sûre|mort|morte|chaud|chaude|pas|trop|vraiment|toujours|déjà|deja|malade|fatigué|fatiguée|fatigue|dispo|co|en|dans|chez|bizarre|marrant|marrante|drôle|drole|bg|beau|moche|relou|chelou|parti|partie|rentré|rentrée|réveillé|réveillée|sur|devant|derrière|ici|où";
const T_AS_NEXT = "vu|fait|dit|pris|eu|été|raison|tort|compris|mangé|entendu|reçu|capté|bu|joué|gagné|perdu|pas|déjà|deja|encore|quoi|combien|faim|soif|peur|sommeil|besoin|envie|cru|lu|réussi|reussi|fini|oublié|regardé|essayé|acheté|trouvé|vu|cassé|écouté|ecouté|kiffé|aimé|mis|écrit|ecrit|appelé|parlé|répondu|repondu|vu|grandi|changé|reçu|l'air|lair|ton|ta|tes|un|une|des|du|le|la|les|rien|tout|bien|trop";
const A_NEXT = "toute|tout à l'heure|tout a l'heure|demain|plus|bientôt|bientot|tous|toutes|vous|toi|la prochaine|ce soir|plus tard|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|la semaine prochaine|tt";
const A_BEFORE = "nuit|soir|merci|salut|journée|journee|soirée|soiree|bravo|courage|bisous|gg|bonjour|bonsoir|coucou|bienvenue|bon appétit|bon appetit";
const ETRE = "suis|es|est|sommes|êtes|sont|étais|était|étaient|serai|seras|sera|serons|serez|seront|serais|serait|t'es|t’es|chui|reste|restes|restez|sois|soit";
const OU_AFTER = "es|est|êtes|sont|étais|était|vas|va|allez|vont|habites|habite|t'es|t’es|pars|passes|joues|bosses|vis|dors|es-tu|est-il|est-elle|est-ce|t'étais|t’étais|tu es";

const REGEX_RULES: Rule[] = [
    // « je men fou », « il sen fou » → « je m'en fous », « il s'en fout »
    [new RegExp(`${B}(je|tu|il|elle|on|ça|ca)\\s+[mts](?:'|’)?en\\s+fou[st]?${W}`, "giu"), m => {
        const subj = m[1].toLowerCase();
        const pro = subj === "je" ? "m'en" : subj === "tu" ? "t'en" : "s'en";
        return `${m[1]} ${pro} ${subj === "je" || subj === "tu" ? "fous" : "fout"}`;
    }],
    // « je men vais », « tu ten vas », « il sen va »
    [new RegExp(`${B}(je)\\s+men${W}`, "giu"), m => `${m[1]} m'en`],
    [new RegExp(`${B}(tu)\\s+ten${W}`, "giu"), m => `${m[1]} t'en`],
    [new RegExp(`${B}(il|elle|on)\\s+sen${W}`, "giu"), m => `${m[1]} s'en`],
    [new RegExp(`${B}sava${W}`, "giu"), m => caseLike(m[0], "ça va")],
    // « quesque tu fais », « esque tu viens » → « qu'est-ce que », « est-ce que »
    [new RegExp(`${B}(?:quesque|qu'esque|qu’esque|keske|qu'est ce que|qu’est ce que)${W}`, "giu"), m => caseLike(m[0], "qu'est-ce que")],
    [new RegExp(`${START}(esque|est ce que)${W}`, "giu"), m => `${m[1]}${caseLike(m[2], "est-ce que")}`],
    // « appel moi », « envoi moi » en début de phrase : le verbe à l'impératif, pas le nom
    [new RegExp(`${START}(appel|rappel|envoi|renvoi)\\s+(moi|toi|le|la|les|nous|lui|leur)${W}`, "giu"), m => {
        const verb: Record<string, string> = { appel: "appelle", rappel: "rappelle", envoi: "envoie", renvoi: "renvoie" };
        return `${m[1]}${caseLike(m[2], verb[m[2].toLowerCase()])}-${m[3]}`;
    }],
    // « tu me soule » : « soule » est un sport pour le dictionnaire.
    [new RegExp(`${B}(me|te|nous|vous|m'|t')(\\s*)soul(e|es|ent|er|é|ée)${W}`, "giu"), m => `${m[1]}${m[2]}soûl${m[3]}`],
    [new RegExp(`${B}biensur${W}`, "giu"), m => caseLike(m[0], "bien sûr")],
    [new RegExp(`${B}bien sur(?=\\s*(?:[?!.,…]|$))`, "giu"), m => caseLike(m[0], "bien sûr")],
    [new RegExp(`${B}parcontre${W}`, "giu"), m => caseLike(m[0], "par contre")],
    [new RegExp(`${B}(apr[eè]s)[\\s-]midi${W}`, "giu"), m => caseLike(m[1], "après-midi")],
    // « ses pas grave », « s'est trop bien » en début de phrase → « c'est »
    [new RegExp(`${START}(ses|ces|s'est|s’est|sest)(\\s+)(?=(?:${C_EST_NEXT})${W})`, "giu"), m => `${m[1]}${caseLike(m[2], "c'est")}${m[3]}`],
    // « tes ou ? », « tes con » → « t'es »
    [new RegExp(`${START}(tes)(\\s+)(?=(?:${T_ES_NEXT})${W})`, "giu"), m => `${m[1]}${caseLike(m[2], "t'es")}${m[3]}`],
    // « ta vu ? », « ta raison » → « t'as »
    [new RegExp(`${START}(ta)(\\s+)(?=(?:${T_AS_NEXT})${W})`, "giu"), m => `${m[1]}${caseLike(m[2], "t'as")}${m[3]}`],
    // « a demain », « bonne nuit a tous » → « à »
    [new RegExp(`(^|[.!?…]\\s+|\\n|${B}(?:${A_BEFORE})\\s+)(a)(\\s+)(?=(?:${A_NEXT})${W})`, "giu"), m => `${m[1]}${caseLike(m[2], "à")}${m[3]}`],
];

// Après « être », « la » en fin de phrase est l'adverbe : « je suis la » → « là ».
const AFTER_SPELLING: Rule[] = [
    // Aussi après une apostrophe (« j'étais la ») et avec « pas », « plus »… (« je suis pas la »).
    [new RegExp(`(?<![\\p{L}\\d_])(${ETRE})((?:\\s+(?:pas|plus|jamais|toujours|encore|déjà|deja|bien|vraiment|trop))?)\\s+la(?=\\s*(?:[?!.,…]|$))`, "giu"), m => `${m[1]}${m[2]} là`],
    [new RegExp(`${B}(${OU_AFTER})\\s+ou(?=\\s*(?:[?!.,…]|$))`, "giu"), m => `${m[1]} où`],
    [new RegExp(`(^|[.!?…]\\s+|\\n)(ou)(\\s+)(?=(?:est|sont|t'es|t’es|es|étais|était|tu es|tu vas|tu étais|vas-tu|on va|on est|il est|elle est)${W})`, "giu"), m => `${m[1]}${caseLike(m[2], "où")}${m[3]}`],
];

const PRONOUNS = new Set("je j' tu il elle on ça ca qui que ne me te se le la les lui leur nous vous y en".split(" "));

const SUBJECT_L: Record<string, string> = { "je": "je l'ai", "j'": "je l'ai", "tu": "tu l'as", "il": "il l'a", "elle": "elle l'a", "on": "on l'a", "ils": "ils l'ont", "elles": "elles l'ont" };

function morphRules(speller: ChatSpeller): Rule[] {
    return [
        // « tu la vu », « il la pris » → « tu l'as vu », « il l'a pris » (participe passé après « la »)
        [new RegExp(`${B}(je|tu|il|elle|on|ils|elles)\\s+la\\s+(\\p{L}+)`, "giu"), m => {
            if (!hasTag(speller.getMorph(m[2].toLowerCase()), ":Q")) return null;
            return `${caseLike(m[1], SUBJECT_L[m[1].toLowerCase()])} ${m[2]}`;
        }],
        // « explique toi », « si regarde moi » → trait d'union de l'impératif (Grammalecte ne le
        // voit qu'en début de phrase). Pas après un sujet ou un pronom (« je te regarde toi »).
        [new RegExp(`${B}(?:(\\p{L}+['’]?)\\s+)?(\\p{L}+)\\s+(moi|toi)(?=\\s*(?:[?!.,…]|$))`, "giu"), m => {
            if (m[1] && PRONOUNS.has(m[1].toLowerCase())) return null;
            if (!speller.getMorph(m[2].toLowerCase()).some(x => x.includes(":E:2s"))) return null;
            return `${m[1] ? m[0].slice(0, m[0].indexOf(m[2], m[1].length)) : ""}${m[2]}-${m[3]}`;
        }],
        // « elle ma dit », « tu ma fait peur » → « m'a », « m'as » (participe passé après « ma »)
        [new RegExp(`${B}(il|elle|on|ça|ca|qui|tu|ils|elles)\\s+ma\\s+(\\p{L}+)`, "giu"), m => {
            let verb = m[2];
            const morph = speller.getMorph(verb.toLowerCase());
            // « il ma appeler » : l'infinitif en -er devient le participe (« m'a appelé »).
            if (!hasTag(morph, ":Q")) {
                if (!hasTag(morph, ":Y") || !/er$/i.test(verb)) return null;
                verb = verb.slice(0, -2) + "é";
                if (!hasTag(speller.getMorph(verb.toLowerCase()), ":Q")) return null;
            }
            const subj = m[1].toLowerCase();
            return `${m[1]} ${subj === "tu" ? "m'as" : subj === "ils" || subj === "elles" ? "m'ont" : "m'a"} ${verb}`;
        }],
        // « je les vu » → « je les ai vu » (participe passé sans auxiliaire)
        [new RegExp(`${B}(je|j'|tu|il|elle|on|ils|elles)\\s+les\\s+((?:(?:déjà|deja|jamais|pas|plus|toujours|encore|bien|trop|tous)\\s+)?)(\\p{L}+)`, "giu"), m => {
            const morph = speller.getMorph(m[3].toLowerCase());
            // Seulement un participe qui n'est pas aussi un verbe conjugué (« je les vois » ne bouge pas).
            if (!hasTag(morph, ":Q") || morph.some(x => /:(?:Ip|Iq|Is|If|K|Sp|Sq|E):/.test(x))) return null;
            const subj = m[1].toLowerCase();
            const aux = subj === "je" || subj === "j'" ? "ai" : subj === "tu" ? "as" : subj === "ils" || subj === "elles" ? "ont" : "a";
            return `${m[1].toLowerCase() === "j'" ? "je" : m[1]} les ${aux} ${m[2]}${m[3]}`;
        }],
        // « mes potes son la », « ils son partis » → « sont » (après un pluriel, devant là / un participe…)
        [new RegExp(`${B}(\\p{L}+)\\s+son\\s+(?=(?:là|la|pas|plus|partis|parties|venus|venues|allés|allées|arrivés|arrivées|chauds|chaudes|où|ou|ici|trop|tous|toutes|en|dans|chez|morts|nuls|forts|beaux|bons|grands|petits|là-bas|fous|ouf)${W})`, "giu"), m => {
            const prev = m[1].toLowerCase();
            const plural = ["ils", "elles", "qui", "eux", "ceux", "celles"].includes(prev) || speller.getMorph(prev).some(x => /:p(?:[:/]|$)/.test(x));
            if (!plural) return null;
            return `${m[1]} sont `;
        }],
        // « tu serrais venue » → « tu serais venue » (conditionnel de être, pas de serrer)
        [new RegExp(`${B}(serr)(ai|ais|ait|aient|ions|iez)(\\s+)(\\p{L}+)`, "giu"), m => {
            if (!hasTag(speller.getMorph(m[4].toLowerCase()), ":Q")) return null;
            return `${caseLike(m[1], "ser")}${m[2]}${m[3]}${m[4]}`;
        }],
    ];
}

type Spans = (text: string) => [number, number][];

function apply(text: string, rules: Rule[], spansOf: Spans, fixes: ChatFix[]) {
    let cur = text;
    for (const [re, fn] of rules) {
        // Zones protégées (liens, code…) recalculées : la règle précédente a pu décaler le texte.
        const spans = spansOf(cur);
        const protectedAt = (a: number, b: number) => spans.some(([x, y]) => a < y && b > x);
        let out = "";
        let last = 0;
        re.lastIndex = 0;
        for (let m = re.exec(cur); m; m = re.exec(cur)) {
            if (m[0] === "") { re.lastIndex++; continue; }
            if (protectedAt(m.index, m.index + m[0].length)) continue;
            const to = fn(m);
            if (to == null || to === m[0]) continue;
            out += cur.slice(last, m.index) + to;
            last = m.index + m[0].length;
            fixes.push({ from: m[0].trim(), to: to.trim() });
        }
        if (last) cur = out + cur.slice(last);
    }
    return cur;
}

/** Règles d'avant l'orthographe (texte seul). */
export const chatBefore = (text: string, spansOf: Spans, fixes: ChatFix[]) =>
    apply(text, REGEX_RULES, spansOf, fixes);

/** Règles d'après l'orthographe : elles lisent des mots déjà corrigés (« etait » → « était »). */
export const chatAfter = (text: string, spansOf: Spans, speller: ChatSpeller | undefined, fixes: ChatFix[]) =>
    apply(text, [...(speller ? morphRules(speller) : []), ...AFTER_SPELLING], spansOf, fixes);
