import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { ViewPayload } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { describeGap, type EligibilityGap, NETWORK_BIOMES, type ServerCard } from "../services/network-eligibility.service";
import { type NetworkAlertRow, type NetworkGuildRow, type NetworkPingRow, NetworkStatus } from "../types";
import { serverNameLink } from "./network-mirror.view";

const NETWORK_COLOR = 0x8b5cf6;
const ERROR_COLOR = 0xf43f5e;

/** Customid prefix of the Approve/Reject buttons on a join request DM - routed by `network-review.component.ts`. */
export const NETWORK_REVIEW_PREFIX = "biomehunt:network-review";

/** A single Components V2 container as a whole reply - mentions are shown, never pinged. */
export function v2(container: ContainerBuilder): ViewPayload {
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: NO_PINGS };
}

export function buildEligibilityContainer(gaps: EligibilityGap[]): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ERROR_COLOR);
    const lines = gaps.map((g) => `- ${describeGap(g)}`).join("\n");
    container.addTextDisplayComponents((td) =>
        td.setContent(`**Your server is not eligible to join the Network.**\nStill missing:\n${lines}`),
    );
    return container;
}

function cardLines(card: ServerCard): string {
    return [
        `Active members (7d): **${card.activeMembers}**`,
        `Macro hours: **${card.macroHours7d}h** (7d) · **${card.macroHours30d}h** (30d)`,
    ].join("\n");
}

export interface JoinRequestParams {
    guildId: string;
    guildName: string;
    /** The server's invite - its name links to it when set. */
    inviteUrl?: string | null;
    card: ServerCard;
    /** Set once an owner decided - the buttons are then replaced by who decided. */
    decided?: { approved: boolean; byUserId: string };
}

/** The join request a bot owner gets by DM. */
export function buildJoinRequestContainer(p: JoinRequestParams): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(NETWORK_COLOR);
    container.addTextDisplayComponents((td) =>
        td.setContent(`## Network join request\n${serverNameLink(p.guildName, p.inviteUrl ?? null)} (\`${p.guildId}\`)`),
    );
    container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(cardLines(p.card)));

    const decided = p.decided;
    if (decided) {
        container.addTextDisplayComponents((td) =>
            td.setContent(`${decided.approved ? "✅ Approved" : "❌ Rejected"} by <@${decided.byUserId}>`),
        );
        return container;
    }

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${NETWORK_REVIEW_PREFIX}:${p.guildId}:approve`)
                .setLabel("Approve")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`${NETWORK_REVIEW_PREFIX}:${p.guildId}:reject`).setLabel("Reject").setStyle(ButtonStyle.Danger),
        ),
    );
    return container;
}

const STATUS_LABEL: Record<NetworkStatus, string> = {
    [NetworkStatus.NONE]: "Not in the Network",
    [NetworkStatus.PENDING]: "Join request waiting for approval",
    [NetworkStatus.MEMBER]: "Member",
};

const channel = (id: string | null) => (id ? `<#${id}>` : "not set");
const role = (id: string | null) => (id ? `<@&${id}>` : "none");

export interface StatusParams {
    row: NetworkGuildRow | null;
    gaps: EligibilityGap[];
    card: ServerCard;
    pings: NetworkPingRow[];
}

/** `/bh-network status`: where the guild stands, what it still lacks, its config and its card. */
export function buildStatusContainer(p: StatusParams): ContainerBuilder {
    const status = p.row ? STATUS_LABEL[p.row.status] : STATUS_LABEL[NetworkStatus.NONE];
    const forced = p.row?.forced && p.row.status === NetworkStatus.MEMBER ? " (forced by the bot owner)" : "";
    const checklist = p.gaps.length === 0 ? "✅ All requirements met" : p.gaps.map((g) => `❌ ${describeGap(g)}`).join("\n");
    const pingByBiome = new Map(p.pings.map((ping) => [ping.biome, ping.role_id]));
    const config = [
        `Network channel: ${channel(p.row?.network_channel_id ?? null)}`,
        `Staff: ${channel(p.row?.staff_channel_id ?? null)} · ${role(p.row?.staff_role_id ?? null)}`,
        `Announcements role: ${role(p.row?.announce_role_id ?? null)}`,
        `Invite: ${p.row?.invite_url ?? "none"}`,
        ...NETWORK_BIOMES.map((b) => `${formatBiomeName(b)} ping: ${role(pingByBiome.get(b) ?? null)}`),
    ].join("\n");

    const container = new ContainerBuilder().setAccentColor(NETWORK_COLOR);
    container.addTextDisplayComponents((td) => td.setContent(`## 🌐 Network status\n**${status}${forced}**`));
    container.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(`**Requirements**\n${checklist}`));
    container.addTextDisplayComponents((td) => td.setContent(`**Settings**\n${config}`));
    container.addTextDisplayComponents((td) => td.setContent(`**Activity**\n${cardLines(p.card)}`));
    return container;
}

const ALERT_DETAIL_MAX = 200;

/** `/bh-owner network lookup`'s alert history: one line per alert (first line of its details, cut short). */
export function formatAlertLines(alerts: NetworkAlertRow[]): string {
    if (alerts.length === 0) return "No alerts.";
    return alerts
        .map((a) => {
            const first = a.details.split("\n")[0];
            const detail = first.length > ALERT_DETAIL_MAX ? `${first.slice(0, ALERT_DETAIL_MAX)}...` : first;
            return `- <t:${Math.floor(a.created_at.getTime() / 1000)}:R> \`${a.kind}\` ${detail}`;
        })
        .join("\n");
}
