/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — connexion d'un compte du Token Importer, choix du salon
// vocal et de la source audio. Pas de champ token : le compte est choisi dans
// la liste (rien ne s'affiche à l'écran, même en partage d'écran).

import { type Folder, getAccounts, getFolders, type SavedAccount } from "@lowplugins/tokenImporter";
import { classNameFactory } from "@utils/css";
import { useEffect, useMemo, useState } from "@webpack/common";

import { connect, DEFAULT_INPUT, devices, disconnect, type EngineState, errorText, join, leave, setInput, useMusical } from "./engine";

const cl = classNameFactory("lc-mu-");

const STATE_LABEL: Record<EngineState, string> = {
    connecting: "Connexion…",
    connected: "Connecté",
    reconnecting: "Reconnexion…",
    in_voice: "En vocal",
    connected_left: "Connecté",
    error: "Erreur",
    disconnected: "Déconnecté",
};

export function ConnectionSection() {
    const music = useMusical();
    const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [accountId, setAccountId] = useState("");
    const [guildId, setGuildId] = useState("");
    const [channelId, setChannelId] = useState("");
    const [inputs, setInputs] = useState<string[] | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([getAccounts(), getFolders()])
            .then(([a, f]) => { setAccounts(a); setFolders(f); })
            .catch(e => setError(errorText(e)));
    }, []);

    const connected = music.running && !!music.state && music.state !== "disconnected" && music.state !== "error";
    const ready = music.state === "connected" || music.state === "connected_left" || music.state === "in_voice";

    // Liste des sources dès que le moteur tourne.
    useEffect(() => {
        if (!music.running || inputs) return;
        devices().then(setInputs).catch(() => { });
    }, [music.running]);

    // Se recaler sur le salon où le compte est déjà (panneau rouvert).
    useEffect(() => {
        if (music.current) {
            setGuildId(music.current.guild);
            setChannelId(music.current.channel);
        }
    }, [music.current?.guild, music.current?.channel]);

    const groups = useMemo(() => {
        if (!accounts) return [];
        const byFolder = new Map<string | null, SavedAccount[]>([[null, []]]);
        for (const f of folders) byFolder.set(f.id, []);
        for (const a of accounts) byFolder.get(a.folderId && byFolder.has(a.folderId) ? a.folderId : null)!.push(a);
        return [
            ...folders.map(f => ({ name: f.name, accounts: byFolder.get(f.id)! })),
            { name: folders.length ? "Non classés" : "Comptes", accounts: byFolder.get(null)! },
        ].filter(g => g.accounts.length);
    }, [accounts, folders]);

    const guild = music.guilds?.find(g => g.id === guildId);
    const connectedAccount = accounts?.find(a => a.id === music.accountId);

    async function act(fn: () => Promise<unknown>) {
        setPending(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setPending(false);
        }
    }

    const doConnect = () => {
        const account = accounts?.find(a => a.id === accountId);
        if (account) act(() => connect(account));
    };

    if (accounts && !accounts.length) {
        return (
            <div className={cl("card")}>
                <div className={cl("row")}>
                    <div className={cl("state")}>
                        <div className={cl("state-name")}>Aucun compte</div>
                        <div className={cl("state-detail")}>Ajoute un compte dédié dans le Token Importer pour l'utiliser ici.</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={cl("card")}>
            {/* Compte */}
            <div className={cl("row")}>
                <span className={cl("dot", music.state === "in_voice" && "dot-on", ready && music.state !== "in_voice" && "dot-ready")} />
                <div className={cl("state")}>
                    <div className={cl("state-name")}>
                        {connected && music.state ? STATE_LABEL[music.state] : "Non connecté"}
                        {music.user && ` · ${music.user.username}`}
                    </div>
                    <div className={cl("state-detail")}>
                        {/* Après une erreur, le moteur annonce aussi « déconnecté » : l'erreur reste affichée. */}
                        {(music.state === "error" || music.state === "disconnected") && music.error ? music.error
                            : !music.running && music.exitReason && music.exitReason !== "moteur arrêté" ? music.exitReason
                                : connected ? (connectedAccount ? `Compte du Token Importer : ${connectedAccount.username}` : "")
                                    : "Choisis un compte du Token Importer."}
                    </div>
                </div>
                {!connected ? (
                    <div className={cl("actions")}>
                        <select className={cl("select")} value={accountId} disabled={pending || !accounts} onChange={e => setAccountId(e.currentTarget.value)}>
                            <option value="">{accounts ? "Choisir un compte" : "Chargement…"}</option>
                            {groups.map(g => (
                                <optgroup key={g.name} label={g.name}>
                                    {g.accounts.map(a => (
                                        <option key={a.id} value={a.id} disabled={!!a.locked}>
                                            {a.username}{a.locked ? " (illisible sur ce PC)" : ""}
                                        </option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        <button className={cl("btn", "btn-primary")} disabled={pending || !accountId} onClick={doConnect}>Connecter</button>
                    </div>
                ) : (
                    <div className={cl("actions")}>
                        <button className={cl("btn")} disabled={pending} onClick={() => act(disconnect)}>Déconnecter</button>
                    </div>
                )}
            </div>

            {/* Salon */}
            {ready && (
                <div className={cl("row")}>
                    <div className={cl("field")}>
                        <span className={cl("label")}>Serveur</span>
                        <select className={cl("select")} value={guildId} disabled={pending} onChange={e => { setGuildId(e.currentTarget.value); setChannelId(""); }}>
                            <option value="">{music.guilds?.length ? "Choisir un serveur" : "Aucun serveur avec un salon vocal"}</option>
                            {music.guilds?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                    </div>
                    <div className={cl("field")}>
                        <span className={cl("label")}>Salon vocal</span>
                        <select className={cl("select")} value={channelId} disabled={pending || !guild} onChange={e => setChannelId(e.currentTarget.value)}>
                            <option value="">Choisir un salon</option>
                            {guild?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </div>
                    <div className={cl("actions", "actions-end")}>
                        {music.state === "in_voice" && music.current?.channel === channelId ? (
                            <button className={cl("btn")} disabled={pending} onClick={() => act(leave)}>Quitter</button>
                        ) : (
                            <button className={cl("btn", "btn-primary")} disabled={pending || !channelId} onClick={() => act(() => join(guildId, channelId))}>
                                Rejoindre
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Source audio */}
            {connected && (
                <div className={cl("row")}>
                    <div className={cl("field", "field-wide")}>
                        <span className={cl("label")}>Source audio</span>
                        <select className={cl("select")} value={music.source ?? ""} disabled={pending || !inputs} onChange={e => { const v = e.currentTarget.value; if (v) act(() => setInput(v)); }}>
                            <option value="" disabled>Aucune source (silence)</option>
                            <option value={DEFAULT_INPUT}>Entrée par défaut</option>
                            {inputs?.map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        {music.captureError && <span className={cl("field-error")}>{music.captureError}</span>}
                        {!music.source && <span className={cl("field-hint")}>Rien n'est diffusé tant qu'aucune source n'est choisie.</span>}
                    </div>
                </div>
            )}

            {error && <div className={cl("error")}>{error}</div>}
        </div>
    );
}
