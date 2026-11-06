/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ImageToolkit — l'avatar et la bannière du profil de quelqu'un :
 *  - clic : l'image s'ouvre en grand ;
 *  - clic droit : rechercher l'image (Google Lens, Yandex…), copier,
 *    enregistrer, copier / ouvrir le lien.
 *  Jamais sur ton propre profil ni dans l'éditeur de profil.
 *  - images des messages : « Rechercher l'image » dans le menu de Discord
 *    (copier / enregistrer y sont déjà).
 *
 * Les recherches ouvrent le navigateur avec l'adresse de l'image : rien n'est
 * envoyé tant que tu ne choisis pas un moteur.
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { CopyIcon, ImageIcon, LinkIcon, OpenExternalIcon } from "@components/Icons";
import { t } from "@lowcord/i18n";
import { isAnimated, isDiscordCdn, openFullImage, ProfileImage, resizeImage, setProfileImageHandler } from "@lowcord/profileImages";
import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { ContextMenuApi, Menu, showToast } from "@webpack/common";

const logger = new Logger("ImageToolkit");

const ENGINES: Record<string, string> = {
    "Google Lens": "https://lens.google.com/uploadbyurl?url=",
    "Google Images": "https://www.google.com/searchbyimage?sbisrc=cr_1&image_url=",
    Yandex: "https://yandex.com/images/search?rpt=imageview&url=",
    Bing: "https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:",
    TinEye: "https://www.tineye.com/search?url=",
    SauceNAO: "https://saucenao.com/search.php?url=",
    IQDB: "https://iqdb.org/?url=",
};

const openExternal = (url: string) => VencordNative.native.openExternal(url);

function search(url: string, engine: string) {
    openExternal(ENGINES[engine] + encodeURIComponent(url));
}

/** Image en pleine taille, seulement depuis les serveurs de Discord. */
async function download(url: string, format: "png" | "gif") {
    const full = resizeImage(url, 4096, format);
    if (!isDiscordCdn(full)) throw new Error("adresse refusée");
    const res = await fetch(full);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

async function copyImage(url: string) {
    try {
        // Le presse-papiers ne garde qu'une image fixe : toujours en PNG.
        const data = await download(url, "png");
        if (IS_DISCORD_DESKTOP) DiscordNative.clipboard.copyImage(data, url);
        else await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([data], { type: "image/png" }) })]);
        showToast({ text: t("it.copied"), variant: "success" });
    } catch (e) {
        logger.error("Copie de l'image impossible", e);
        showToast({ text: t("it.copyFailed"), variant: "critical" });
    }
}

async function saveImage(image: ProfileImage) {
    try {
        const ext = isAnimated(image.url) ? "gif" : "png";
        const data = await download(image.url, ext);
        const who = (image.user.username || image.user.id).replace(/[^\w.-]/g, "_");
        const filename = `${who}-${image.kind === "banner" ? "banniere" : "avatar"}.${ext}`;
        if (IS_DISCORD_DESKTOP) {
            await DiscordNative.fileManager.saveWithDialog(data, filename);
        } else {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([data]));
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        }
    } catch (e) {
        logger.error("Enregistrement de l'image impossible", e);
        showToast({ text: t("it.saveFailed"), variant: "critical" });
    }
}

function SearchItem({ url }: { url: string; }) {
    return (
        <Menu.MenuItem id="vc-it-search" label={t("it.search")} leadingAccessory={{ type: "icon", icon: OpenExternalIcon }}>
            {Object.keys(ENGINES).map(name => (
                <Menu.MenuItem key={name} id={`vc-it-search-${name.replace(/\s/g, "-").toLowerCase()}`} label={name} action={() => search(url, name)} />
            ))}
        </Menu.MenuItem>
    );
}

function ProfileImageMenu({ image }: { image: ProfileImage; }) {
    // Adresse publique en bonne taille : c'est elle qu'on partage / cherche.
    const link = resizeImage(image.url, 1024);
    return (
        <Menu.Menu navId="vc-image-toolkit" onClose={ContextMenuApi.closeContextMenu} aria-label={t("it.menu")}>
            {SearchItem({ url: link })}
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-it-copy" label={t("it.copy")} leadingAccessory={{ type: "icon", icon: CopyIcon }} action={() => copyImage(image.url)} />
            <Menu.MenuItem id="vc-it-save" label={t("it.save")} leadingAccessory={{ type: "icon", icon: ImageIcon }} action={() => saveImage(image)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="vc-it-copy-link" label={t("it.copyLink")} leadingAccessory={{ type: "icon", icon: LinkIcon }} action={() => copyToClipboard(link).then(() => showToast({ text: t("it.linkCopied"), variant: "success" }))} />
            <Menu.MenuItem id="vc-it-open-link" label={t("it.openLink")} leadingAccessory={{ type: "icon", icon: OpenExternalIcon }} action={() => openExternal(link)} />
        </Menu.Menu>
    );
}

/** Image d'un message : pièce jointe / intégration image (pas une vidéo, pas un émoji). */
function messageImageUrl(props: any): string | null {
    const media = props?.mediaItem;
    if (media?.url) {
        const type = String(media.contentType ?? "");
        return type.startsWith("image/") ? media.url : null;
    }
    const src = props?.itemSrc;
    if (typeof src !== "string" || !/^https:\/\//.test(src)) return null;
    try {
        const u = new URL(src);
        if (/\/(emojis|stickers|avatars|guilds\/\d+\/users)\//.test(u.pathname)) return null;
    } catch {
        return null;
    }
    return src;
}

const messageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const url = messageImageUrl(props);
    if (!url) return;
    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(SearchItem({ url }));
};

// Clic droit dans la visionneuse d'images de Discord (image ouverte en grand) :
// « Rechercher l'image » après « Copier / Ouvrir le lien de l'image ».
const imageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const src = props?.src;
    if (typeof src !== "string" || !/^https:\/\//.test(src)) return;
    const group = findGroupChildrenByChildId("copy-native-link", children) ?? children;
    group.push(SearchItem({ url: src }));
};

export default definePlugin({
    name: "ImageToolkit",
    description: "Click the avatar or banner of someone's profile to enlarge it, right-click it to search, copy, save or open the image; also search images from the message menu and the image viewer.",
    tags: ["Media", "Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    dependencies: ["DynamicImageModalAPI"],

    contextMenus: {
        "message": messageContextMenu,
        "image-context": imageContextMenu,
    },

    start() {
        // Clic simple : l'image en grand. Clic droit : les outils.
        setProfileImageHandler("click", "ImageToolkit", image => openFullImage(image.url, image.kind));
        setProfileImageHandler("context", "ImageToolkit", (image, event) => {
            if (event) ContextMenuApi.openContextMenu(event as any, () => <ProfileImageMenu image={image} />);
        });
    },

    stop() {
        setProfileImageHandler("click", "ImageToolkit", null);
        setProfileImageHandler("context", "ImageToolkit", null);
    },
});
