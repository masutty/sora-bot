import { ButtonStyle, ContainerBuilder, type MessageComponentInteraction, MessageFlags, PermissionFlagsBits } from "discord.js";
import { confirm, defineView, UserFacingError, type ViewDefinition, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { formatPurchaseCode, formatSeeds, STATUS_COLORS } from "../constants/shop.constants";
import { deliverFlow, refundFlow, type ShopDeps } from "../services/shop.service";
import type { PurchaseRow } from "../types";

export const SHOP_MANAGE_PREFIX = "biomehunt:shop-manage";

type StatusKey = "pending" | "delivered" | "refunded" | "failed";

const statusKey = (p: PurchaseRow): StatusKey => (p.status === "refunded" && p.refund_reason === "role_failed" ? "failed" : p.status);
const isRoleKind = (p: PurchaseRow) => p.kind === "role" || p.kind === "timed_role";
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const ANSI = {
    yellow: "\u001b[1;33m",
    green: "\u001b[1;32m",
    gray: "\u001b[1;30m",
    red: "\u001b[1;31m",
    white: "\u001b[37m",
    reset: "\u001b[0m",
};

/** The `ansi` code block at the top of a sale post and a purchase card: status in bold colour, then the ID in white. */
export function statusBanner(p: PurchaseRow): string {
    const [color, label] = {
        pending: [ANSI.yellow, "PENDING"],
        delivered: [ANSI.green, isRoleKind(p) ? "ROLE GIVEN" : "DELIVERED"],
        refunded: [ANSI.gray, "REFUNDED"],
        failed: [ANSI.red, "REFUNDED - ROLE FAILED"],
    }[statusKey(p)];
    return `\`\`\`ansi\n${color}● ${label}${ANSI.reset}  ${ANSI.white}${formatPurchaseCode(p.code)}${ANSI.reset}\n\`\`\``;
}

export function statusColor(p: PurchaseRow): number {
    return STATUS_COLORS[statusKey(p)];
}

/** `<emoji> **<name>** · <price>` - the item as it was when bought. */
const itemLine = (p: PurchaseRow) => `${p.item_emoji ? `${p.item_emoji} ` : ""}**${p.item_name}** · ${formatSeeds(p.price)}`;

/** The role and, for a timed one, when it ends. */
function roleText(p: PurchaseRow): string {
    const role = p.role_id ? `<@&${p.role_id}>` : "the role";
    return p.role_ends_at ? `${role} until <t:${unix(p.role_ends_at)}:D>` : role;
}

/** The sale post's second line, by status. */
function statusLine(p: PurchaseRow): string {
    const buyer = `<@${p.buyer_discord_id}>`;
    const at = p.decided_at ? ` <t:${unix(p.decided_at)}:R>` : "";
    switch (statusKey(p)) {
        case "pending":
            return `${buyer} · <t:${unix(p.created_at)}:R>`;
        case "delivered":
            if (isRoleKind(p) && p.role_id) return `${buyer} · ${roleText(p)}`;
            return p.decided_by ? `${buyer} · delivered by <@${p.decided_by}>${at}` : `${buyer} · delivered${at}`;
        case "refunded":
            return p.decided_by ? `${buyer} · refunded by <@${p.decided_by}>${at}` : `${buyer} · refunded${at}`;
        case "failed":
            return `${buyer} · the bot couldn't give ${p.role_id ? `<@&${p.role_id}>` : "the role"}`;
    }
}

/** S1: the sales-channel post. Never pings. */
export function buildSalePost(p: PurchaseRow) {
    const container = new ContainerBuilder()
        .setAccentColor(statusColor(p))
        .addTextDisplayComponents((td) => td.setContent(statusBanner(p)))
        .addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(`${itemLine(p)}\n${statusLine(p)}`))
                .setButtonAccessory((b) =>
                    b.setCustomId(`${SHOP_MANAGE_PREFIX}:${p.code}`).setLabel("Manage").setStyle(ButtonStyle.Secondary),
                ),
        );
    return { components: [container], flags: MessageFlags.IsComponentsV2 as const, allowedMentions: NO_PINGS };
}

/** `7d`, `1d12h`, `90m` - for the refund confirm. */
function formatSpan(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join("") || "0m";
}

/** Only what a refund will undo. */
async function refundBullets(deps: ShopDeps, p: PurchaseRow): Promise<string> {
    const lines: string[] = [];
    if (p.price > 0) {
        lines.push(
            p.user_id === null
                ? `${formatSeeds(p.price)} can't go back - <@${p.buyer_discord_id}> has no profile anymore`
                : `${formatSeeds(p.price)} go back to <@${p.buyer_discord_id}>`,
        );
    }
    if (isRoleKind(p) && p.role_id) {
        const impact = await deps.refundRoleImpact(p, deps.now());
        if (impact.removeRole) lines.push(`<@&${p.role_id}> is removed`);
        else if (p.kind === "timed_role" && impact.lostSeconds > 0) lines.push(`<@&${p.role_id}> loses ${formatSpan(impact.lostSeconds)}`);
    }
    const item = await deps.getItem(p.guild_id, p.item_id);
    if (item && !item.removed_at && item.stock !== null) lines.push(`The stock goes back to ${item.stock + 1}`);
    return lines.map((l) => `- ${l}`).join("\n");
}

export interface PurchaseCardState {
    purchase: PurchaseRow;
    guildId: string;
    fromMenu: boolean;
}

export interface PurchaseCardInput {
    guildId: string;
    code: string;
    fromMenu: boolean;
}

const GONE = "This purchase no longer exists.";
const NOT_ADMIN = "Only admins can manage purchases.";

/** The Manage button already checks this; the card checks it again on every decision. */
const isAdmin = (raw: unknown) => !!(raw as Partial<MessageComponentInteraction>).memberPermissions?.has(PermissionFlagsBits.Administrator);

/**
 * A6: one purchase for an admin to decide - `biomehunt.shop-purchase`. Opened from the Purchases tab
 * (`fromMenu`, with Back) or from a sale post's Manage button (no Back). A stale decision tells the
 * admin the current status and redraws with it.
 */
export function purchaseCardView(deps: ShopDeps): ViewDefinition<PurchaseCardState, void, PurchaseCardInput> {
    const reload = async (c: { state: PurchaseCardState }) => {
        const fresh = await deps.getPurchaseByCode(c.state.guildId, c.state.purchase.code);
        if (fresh) c.state.purchase = fresh;
        return fresh;
    };
    return defineView<PurchaseCardState, void, PurchaseCardInput>({
        name: "biomehunt.shop-purchase",
        initial: async ({ guildId, code, fromMenu }) => {
            const purchase = await deps.getPurchaseByCode(guildId, code);
            if (!purchase) throw new UserFacingError(GONE);
            return { purchase, guildId, fromMenu };
        },
        render: ({ purchase: p, fromMenu }, kit): ViewRender => {
            const lines = [`Bought by <@${p.buyer_discord_id}> · <t:${unix(p.created_at)}:f>`];
            if (p.kind === "timed_role" && p.role_id && p.role_ends_at && p.status !== "refunded") lines.push(roleText(p));
            const container = new ContainerBuilder()
                .setAccentColor(statusColor(p))
                .addTextDisplayComponents((td) => td.setContent(statusBanner(p)))
                .addTextDisplayComponents((td) => td.setContent(`${itemLine(p)}\n${lines.join("\n")}`));
            const buttons = [
                ...(p.status === "pending"
                    ? [kit.button("deliver", (b) => b.setLabel("Mark delivered").setStyle(ButtonStyle.Success))]
                    : []),
                ...(p.status !== "refunded" ? [kit.button("refund", (b) => b.setLabel("Refund").setStyle(ButtonStyle.Danger))] : []),
                ...(fromMenu ? [kit.button("back", (b) => b.setLabel("Back"))] : []),
            ];
            return {
                flags: MessageFlags.IsComponentsV2,
                components: buttons.length > 0 ? [container, kit.row(...buttons)] : [container],
                allowedMentions: NO_PINGS,
            };
        },
        on: {
            back: (c) => c.done(),
            deliver: async (c) => {
                if (!isAdmin(c.raw)) return c.notify(NOT_ADMIN);
                const res = await deliverFlow(deps, c.state.guildId, c.state.purchase.code, c.user.id);
                if (res.kind === "ok") c.state.purchase = res.purchase;
                else if (res.kind === "not_pending") {
                    c.state.purchase = res.purchase;
                    await c.notify(`This purchase is already ${res.purchase.status}.`);
                } else await c.notify(GONE);
            },
            refund: async (c) => {
                if (!isAdmin(c.raw)) return c.notify(NOT_ADMIN);
                const current = await reload(c);
                if (!current) return c.notify(GONE);
                if (current.status === "refunded") return c.notify("This purchase is already refunded.");
                const { guildId } = c.state;
                await c.open(
                    confirm({
                        name: "biomehunt.shop-refund",
                        title: `Refund \`${formatPurchaseCode(current.code)}\`?`,
                        body: await refundBullets(deps, current),
                        color: STATUS_COLORS.failed,
                        confirmLabel: "Refund",
                        confirmStyle: ButtonStyle.Danger,
                        cancelStyle: ButtonStyle.Secondary,
                        onConfirm: async () => {
                            const res = await refundFlow(deps, guildId, current.code, c.user.id);
                            if (res.kind === "not_found") throw new UserFacingError(GONE);
                            if (res.kind === "already_refunded") throw new UserFacingError("This purchase is already refunded.");
                            return { content: "Refunded." };
                        },
                    }),
                    undefined,
                );
                await reload(c);
            },
        },
    });
}
