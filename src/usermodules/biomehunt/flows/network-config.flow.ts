import { ButtonStyle, ChannelType, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { defineView, flow, navHandlers, navRow, type StepResult, type ViewPayload } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { getDelayedForwardConfigs } from "../repository/delayed-forwards.repository";
import { getForwardConfigs } from "../repository/forwards.repository";
import { getNetworkGuild, getNetworkPings, setNetworkPing, updateNetworkConfig } from "../repository/network.repository";
import { NETWORK_BIOMES } from "../services/network-eligibility.service";

/** Injected so tests never touch the DB - `defaultNetworkConfigDeps` wires the real repository. */
export interface NetworkConfigDeps {
    getNetworkGuild: typeof getNetworkGuild;
    getNetworkPings: typeof getNetworkPings;
    /** Every live and delayed local forward channel - the Network channel must be none of them. */
    getLocalForwardChannelIds: (guildId: string) => Promise<Set<string>>;
    updateNetworkConfig: typeof updateNetworkConfig;
    setNetworkPing: typeof setNetworkPing;
}

export function defaultNetworkConfigDeps(): NetworkConfigDeps {
    return {
        getNetworkGuild,
        getNetworkPings,
        getLocalForwardChannelIds: async (guildId) => {
            const [live, delayed] = await Promise.all([getForwardConfigs(guildId), getDelayedForwardConfigs(guildId)]);
            return new Set([...live, ...delayed].map((f) => f.channel_id));
        },
        updateNetworkConfig,
        setNetworkPing,
    };
}

interface Ctx {
    guildId: string;
}

const INVITE_RE = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+$/;

export function isValidInvite(url: string): boolean {
    return INVITE_RE.test(url);
}

const channel = (id: string | null) => (id ? `<#${id}>` : "not set");
const role = (id: string | null) => (id ? `<@&${id}>` : "none");
/** A role select's default selection: the current role, so the admin can deselect it (Discord only fires on a change - an empty select can never be cleared). */
const currentRole = (id: string | null | undefined): string[] => (id ? [id] : []);

function stepContainer(title: string, description: string): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x8b5cf6);
    container.addTextDisplayComponents((td) => td.setContent(`## bh-network: ${title}`));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents((td) => td.setContent(description));
    return container;
}

function stepPayload(components: NonNullable<ViewPayload["components"]>): ViewPayload {
    return { flags: MessageFlags.IsComponentsV2, components, allowedMentions: NO_PINGS };
}

function channelStep(deps: NetworkConfigDeps) {
    return defineView<{ guildId: string; current: string | null }, StepResult, Ctx>({
        name: "biomehunt.net-channel",
        initial: async (ctx) => ({ guildId: ctx.guildId, current: (await deps.getNetworkGuild(ctx.guildId))?.network_channel_id ?? null }),
        render: (s, kit) =>
            stepPayload([
                stepContainer(
                    "Network Channel",
                    "Pick the channel where rare biomes from other servers will appear. It can't be one of your local forward channels.\n\n" +
                        `Current: ${channel(s.current)}`,
                ),
                kit.row(kit.channelSelect("channel", (c) => c.setChannelTypes(ChannelType.GuildText).setPlaceholder("Network channel"))),
                navRow(kit, { canBack: false }),
            ]),
        on: {
            channel: async (c) => {
                const id = c.values[0];
                if ((await deps.getLocalForwardChannelIds(c.state.guildId)).has(id)) {
                    await c.notify("That channel is one of your local forward channels - pick a different one for the Network.");
                    return;
                }
                await deps.updateNetworkConfig(c.state.guildId, { networkChannelId: id });
                c.done({ kind: "ok" });
            },
            ...navHandlers(),
        },
    });
}

interface StaffState {
    guildId: string;
    channelId: string | null;
    roleId: string | null;
}

function staffStep(deps: NetworkConfigDeps) {
    const finishIfComplete = (c: { state: StaffState; done(r: StepResult): void }) => {
        if (c.state.channelId && c.state.roleId) c.done({ kind: "ok" });
    };
    return defineView<StaffState, StepResult, Ctx>({
        name: "biomehunt.net-staff",
        initial: async (ctx) => {
            const row = await deps.getNetworkGuild(ctx.guildId);
            return { guildId: ctx.guildId, channelId: row?.staff_channel_id ?? null, roleId: row?.staff_role_id ?? null };
        },
        render: (s, kit) =>
            stepPayload([
                stepContainer(
                    "Staff",
                    "If the Network votes one of your finds Fake, this channel gets a warning that pings this role.\n\n" +
                        `Current: ${channel(s.channelId)} · ${role(s.roleId)}`,
                ),
                kit.row(kit.channelSelect("staffChannel", (c) => c.setChannelTypes(ChannelType.GuildText).setPlaceholder("Staff channel"))),
                kit.row(kit.roleSelect("staffRole", (r) => r.setPlaceholder("Staff role"))),
                navRow(kit, { canBack: true }),
            ]),
        on: {
            staffChannel: async (c) => {
                c.state.channelId = c.values[0];
                await deps.updateNetworkConfig(c.state.guildId, { staffChannelId: c.values[0] });
                finishIfComplete(c);
            },
            staffRole: async (c) => {
                c.state.roleId = c.values[0];
                await deps.updateNetworkConfig(c.state.guildId, { staffRoleId: c.values[0] });
                finishIfComplete(c);
            },
            ...navHandlers(),
        },
    });
}

function pingsStep(deps: NetworkConfigDeps) {
    return defineView<{ guildId: string; pings: Record<string, string | null> }, StepResult, Ctx>({
        name: "biomehunt.net-pings",
        initial: async (ctx) => {
            const rows = await deps.getNetworkPings(ctx.guildId);
            return { guildId: ctx.guildId, pings: Object.fromEntries(rows.map((r) => [r.biome, r.role_id])) };
        },
        render: (s, kit) =>
            stepPayload([
                stepContainer(
                    "Pings",
                    "Which role to ping when each rare biome arrives from another server. Deselect a role for no ping.\n\n" +
                        NETWORK_BIOMES.map((b) => `${formatBiomeName(b)}: ${role(s.pings[b] ?? null)}`).join("\n"),
                ),
                ...NETWORK_BIOMES.map((b) =>
                    kit.row(
                        kit.roleSelect(b, (r) =>
                            r
                                .setMinValues(0)
                                .setMaxValues(1)
                                .setPlaceholder(`${formatBiomeName(b)} ping`)
                                .setDefaultRoles(...currentRole(s.pings[b])),
                        ),
                    ),
                ),
                navRow(kit, { canBack: true, skipLabel: "Done" }),
            ]),
        on: {
            ...Object.fromEntries(
                NETWORK_BIOMES.map((b) => [
                    b,
                    async (c: { state: { guildId: string; pings: Record<string, string | null> }; values: string[] }) => {
                        const roleId = c.values[0] ?? null;
                        c.state.pings[b] = roleId;
                        await deps.setNetworkPing(c.state.guildId, b, roleId);
                    },
                ]),
            ),
            ...navHandlers(),
        },
    });
}

function announceStep(deps: NetworkConfigDeps) {
    return defineView<{ guildId: string; current: string | null }, StepResult, Ctx>({
        name: "biomehunt.net-announce",
        initial: async (ctx) => ({ guildId: ctx.guildId, current: (await deps.getNetworkGuild(ctx.guildId))?.announce_role_id ?? null }),
        render: (s, kit) =>
            stepPayload([
                stepContainer(
                    "Announcements (optional)",
                    `Role to ping on announcements from the bot owner.\n\nCurrent: ${role(s.current)}`,
                ),
                kit.row(
                    kit.roleSelect("role", (r) =>
                        r
                            .setMinValues(0)
                            .setMaxValues(1)
                            .setPlaceholder("Announcements role")
                            .setDefaultRoles(...currentRole(s.current)),
                    ),
                ),
                navRow(kit, { canBack: true }),
            ]),
        on: {
            role: async (c) => {
                await deps.updateNetworkConfig(c.state.guildId, { announceRoleId: c.values[0] ?? null });
                c.done({ kind: "ok" });
            },
            ...navHandlers(),
        },
    });
}

function inviteStep(deps: NetworkConfigDeps) {
    return defineView<{ guildId: string; current: string | null }, StepResult, Ctx>({
        name: "biomehunt.net-invite",
        initial: async (ctx) => ({ guildId: ctx.guildId, current: (await deps.getNetworkGuild(ctx.guildId))?.invite_url ?? null }),
        render: (s, kit) =>
            stepPayload([
                stepContainer(
                    "Invite (optional)",
                    `An invite shown on your server's Network posts, so people can join you.\n\nCurrent: ${s.current ?? "none"}`,
                ),
                navRow(kit, {
                    canBack: true,
                    skipLabel: "Done",
                    extra: [
                        kit.button("set", (b) => b.setLabel("Set invite").setStyle(ButtonStyle.Primary)),
                        kit.button("clear", (b) => b.setLabel("Remove invite")),
                    ],
                }),
            ]),
        on: {
            set: async (c) => {
                const values = await c.modal({
                    title: "Server invite",
                    fields: [{ key: "url", label: "Invite link", required: true, placeholder: "https://discord.gg/yourserver" }],
                });
                if (!values) return;
                const url = values.url.trim();
                if (!isValidInvite(url)) {
                    await c.notify("That's not a Discord invite link - use https://discord.gg/... or https://discord.com/invite/...");
                    return;
                }
                await deps.updateNetworkConfig(c.state.guildId, { inviteUrl: url });
                c.done({ kind: "ok" });
            },
            clear: async (c) => {
                await deps.updateNetworkConfig(c.state.guildId, { inviteUrl: null });
                c.state.current = null;
            },
            ...navHandlers(),
        },
    });
}

/**
 * The Network config, step by step: Network channel → Staff → Pings → Announcements → Invite. Used
 * by `/bh-network join` (whose `onFinish` submits the join request) and `/bh-network config`. The
 * guild's Network row must already exist (`ensureNetworkRow`) - every pick is written right away.
 */
export function networkConfigFlow(deps: NetworkConfigDeps, guildId: string, onFinish: (guildId: string) => Promise<ViewPayload>) {
    return flow<Ctx>({
        name: "biomehunt.net-config",
        context: { guildId },
        steps: [channelStep(deps), staffStep(deps), pingsStep(deps), announceStep(deps), inviteStep(deps)],
        onFinish: (ctx) => onFinish(ctx.guildId),
        onCancel: EmbedFormatter.info("Network setup cancelled."),
        onTimeout: EmbedFormatter.info("Network setup timed out."),
    });
}
