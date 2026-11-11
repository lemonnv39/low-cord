/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// VoiceJoinLog — petite fenêtre des logs d'un salon vocal : heure, compte
// (nom, @pseudo, ID copiable) et ce qu'il a fait. Se met à jour en direct.

import { t, useLang } from "@lowcord/i18n";
import { copyWithToast } from "@utils/discord";
import type { Channel } from "@vencord/discord-types";
import { Modal, openModal, UserStore } from "@webpack/common";

import { clearChannel, Entry, useChannelLogs } from "./logs";

const time = (ms: number) => {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, sameDay
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

function action(e: Entry) {
    switch (e.kind) {
        case "join": return { text: t("vjl.join"), cls: "in" };
        case "moveIn": return { text: e.other ? t("vjl.moveInFrom", { channel: e.other }) : t("vjl.moveIn"), cls: "move" };
        case "leave": return { text: t("vjl.leave"), cls: "out" };
        case "moveOut": return { text: e.other ? t("vjl.moveOutTo", { channel: e.other }) : t("vjl.moveOut"), cls: "move" };
        case "selfJoin": return { text: t("vjl.selfJoin"), cls: "self" };
        case "selfLeave": return { text: t("vjl.selfLeave"), cls: "self" };
    }
}

function Row({ e, guildId }: { e: Entry; guildId?: string | null; }) {
    const user = UserStore.getUser(e.userId);
    const avatar = user?.getAvatarURL?.(guildId ?? undefined, 32);
    const a = action(e);
    return (
        <li className="lc-vjl-row">
            <span className="lc-vjl-time">{time(e.at)}</span>
            {avatar ? <img className="lc-vjl-avatar" src={avatar} alt="" /> : <span className="lc-vjl-avatar" />}
            <span className="lc-vjl-who">
                <span className="lc-vjl-name">{e.name}</span>
                {e.username && <span className="lc-vjl-muted">@{e.username}</span>}
            </span>
            <button className="lc-vjl-id" title={t("vjl.copyId")} onClick={() => copyWithToast(e.userId, t("vjl.idCopied"))}>{e.userId}</button>
            <span className={`lc-vjl-action lc-vjl-${a.cls}`}>{a.text}</span>
            {e.present && e.present.length > 0 && (
                <span className="lc-vjl-present">
                    {t("vjl.present", { n: e.present.length })} {e.present.slice(0, 12).map(p => p.name).join(", ")}{e.present.length > 12 ? " …" : ""}
                </span>
            )}
        </li>
    );
}

function LogWindow({ channel, modalProps }: { channel: Channel; modalProps: any; }) {
    useLang();
    const entries = useChannelLogs(channel.id);

    const copyAll = () => {
        const text = entries.map(e => `${new Date(e.at).toLocaleString()}\t${e.name}${e.username ? ` (@${e.username})` : ""}\t${e.userId}\t${action(e).text}`).join("\n");
        copyWithToast(text, t("vjl.allCopied"));
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title={t("vjl.title", { channel: channel.name })}
            subtitle={t("vjl.subtitle")}
            actions={[
                ...(entries.length ? [
                    { text: t("vjl.clear"), variant: "secondary", onClick: () => clearChannel(channel.id) },
                    { text: t("vjl.copyAll"), variant: "secondary", onClick: copyAll },
                ] : []),
                { text: t("vjl.close"), variant: "primary", onClick: modalProps.onClose },
            ]}
        >
            {entries.length
                ? <ul className="lc-vjl-list">{entries.map((e, i) => <Row key={`${e.at}-${e.userId}-${i}`} e={e} guildId={channel.guild_id} />)}</ul>
                : <div className="lc-vjl-empty">{t("vjl.empty")}</div>}
        </Modal>
    );
}

export function openLogWindow(channel: Channel) {
    openModal(props => <LogWindow channel={channel} modalProps={props} />);
}
