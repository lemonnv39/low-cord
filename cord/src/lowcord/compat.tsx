/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — anciens composants retirés de Vencord (v1.15.16) : `Forms`,
// `Text` et `Button` de @webpack/common, `HeadingTertiary`. Les écrans
// low-cord les utilisent encore ; ce module les recrée à l'identique par-dessus
// les nouveaux composants, pour garder exactement le même rendu sans réécrire
// chaque écran d'un coup.

import { Button as VcButton, ButtonProps, ButtonSize, TextButton, TextButtonProps } from "@components/Button";
import { Divider } from "@components/Divider";
import { Heading, HeadingProps } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Text as VcText, TextProps, TextSize, TextWeight } from "@components/Text";
import type { CSSProperties } from "react";

export const Forms = {
    FormTitle: Heading,
    FormText: Paragraph,
    FormSection: "section" as never,
    FormDivider: Divider as never,
};

export function HeadingTertiary({ children, ...rest }: HeadingProps<"h4">) {
    return <Heading tag="h4" {...rest}>{children}</Heading>;
}

/** `variant="text-md/semibold"` → taille md, graisse semibold. */
type TextCompatProps = TextProps<any> & { variant?: string; color?: string; style?: CSSProperties; };

export function Text({ color, variant, ...rest }: TextCompatProps) {
    const props = rest as TextProps<any>;
    if (variant) {
        const [left, right] = variant.split("/");
        if (left && right) {
            props.size = left.split("-").pop() as TextSize;
            props.weight = right as TextWeight;
        }
    }
    if (color) {
        props.style ??= {};
        props.style.color = `var(--${color}, var(--text-default))`;
    }
    return <VcText {...props} />;
}

const ButtonColor = {
    BRAND: "primary",
    PRIMARY: "secondary",
    RED: "dangerPrimary",
    TRANSPARENT: "secondary",
    CUSTOM: "none",
    GREEN: "positive",
    LINK: "link",
    WHITE: "overlayPrimary",
} as const satisfies Record<string, ButtonProps["variant"]>;

const TextButtonColor = {
    BRAND: "primary",
    PRIMARY: "primary",
    RED: "danger",
    TRANSPARENT: "secondary",
    CUSTOM: "secondary",
    GREEN: "primary",
    LINK: "link",
    WHITE: "secondary",
} as const satisfies Record<keyof typeof ButtonColor, TextButtonProps["variant"]>;

type ButtonCompatProps = Omit<ButtonProps, "color" | "size"> & { look?: string; color?: string; size?: string; };

export function Button({ look, color = "BRAND", size = "medium", ...rest }: ButtonCompatProps) {
    return look === "LINK"
        ? <TextButton variant={TextButtonColor[color as keyof typeof TextButtonColor]} {...rest as TextButtonProps} />
        : <VcButton variant={ButtonColor[color as keyof typeof ButtonColor]} size={size as ButtonSize} {...rest as ButtonProps} />;
}

Button.Looks = { FILLED: "", LINK: "LINK" } as const;
Button.Colors = {
    BRAND: "BRAND",
    PRIMARY: "PRIMARY",
    RED: "RED",
    TRANSPARENT: "TRANSPARENT",
    CUSTOM: "CUSTOM",
    GREEN: "GREEN",
    LINK: "LINK",
    WHITE: "WHITE",
} as const;
Button.Sizes = {
    SMALL: "small",
    MEDIUM: "medium",
    LARGE: "medium",
    XLARGE: "medium",
    NONE: "min",
    MIN: "min",
} as const;
