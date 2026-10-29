/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { TooltipContainer } from "@components/TooltipContainer";
import { t } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { Modal, openModal, TabBar, Timestamp, useState } from "@webpack/common";

import { parseEditContent } from ".";

const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const MiscClasses = findCssClassesLazy("messageContent", "markupRtl");

const cl = classNameFactory("vc-ml-modal-");

export function openHistoryModal(message: any) {
    openModal(props =>
        <ErrorBoundary>
            <HistoryModal modalProps={props} message={message} />
        </ErrorBoundary>
    );
}

const toDate = (v: any) => (v instanceof Date ? v : v ? new Date(v) : null);

export function HistoryModal({ modalProps, message }: { modalProps: RenderModalProps; message: any; }) {
    // Données incomplètes (patch du modèle de message non appliqué) : on se
    // rabat sur ce qui existe au lieu de planter.
    const history: { timestamp: Date; content: string; }[] = Array.isArray(message?.editHistory) ? message.editHistory : [];
    const sent = toDate(message?.timestamp);
    const firstEdit = toDate(message?.firstEditTimestamp) ?? sent;

    const [currentTab, setCurrentTab] = useState(history.length);
    const timestamps = [firstEdit, ...history.map(m => toDate(m.timestamp))];
    const contents = [...history.map(m => m.content), message?.content ?? ""];

    return (
        <Modal {...modalProps} size="lg" title={t("ml.historyTitle")}>
            <TabBar
                type="top"
                look="brand"
                className={classes("vc-settings-tab-bar", cl("tab-bar"))}
                selectedItem={currentTab}
                onItemSelect={setCurrentTab}
            >
                {sent && firstEdit && firstEdit.getTime() !== sent.getTime() && (
                    <TooltipContainer text={t("ml.historyNotLogged")}>
                        <TabBar.Item className="vc-settings-tab-bar-item" id={-1} disabled>
                            <Timestamp className={cl("timestamp")} timestamp={sent} isEdited={true} isInline={false} />
                        </TabBar.Item>
                    </TooltipContainer>
                )}

                {timestamps.map((timestamp, index) => (
                    <TabBar.Item key={index} className="vc-settings-tab-bar-item" id={index}>
                        {timestamp
                            ? <Timestamp className={cl("timestamp")} timestamp={timestamp} isEdited={true} isInline={false} />
                            : "?"}
                    </TabBar.Item>
                ))}
            </TabBar>

            <div className={classes(CodeContainerClasses.markup, MiscClasses.messageContent, Margins.top20)}>
                {parseEditContent(contents[currentTab] ?? "", message)}
            </div>
        </Modal>
    );
}
