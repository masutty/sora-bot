import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ComponentType,
    ContainerBuilder, MessageFlags, RoleSelectMenuBuilder, SeparatorSpacingSize, StringSelectMenuBuilder,
} from "discord.js";
import type { Guild, GuildTextBasedChannel, Message, MessageEditOptions } from "discord.js";
import { EmbedFormatter, NO_ROLE_PINGS } from "@/utils/format";
import { buildPaginationRow, handlePaginationButton } from "@/utils/pagination";
import { getForwardConfigs, removeForwardConfig, setForwardConfig } from "../repository/forwards";
import { BIOME_SELECTOR_CHOICES, formatBiomeName, resolveBiomeSelector, type BiomeForwardRow } from "../types";

const TIMEOUT_MS = 5 * 60_000;
const FORWARDS_PER_PAGE = 10;

type Direction = "forward" | "back" | "cancel" | "timeout";

function formatForwardLine(f: BiomeForwardRow): string {
    return `${formatBiomeName(f.biome)} - <#${f.channel_id}>${f.role_id ? ` (pings <@&${f.role_id}>)` : ""}`;
}

function listContainer(forwards: BiomeForwardRow[], title = "Biome Forwards"): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) =>
        td.setContent(`**${title}**\n${forwards.length > 0 ? forwards.map(formatForwardLine).join("\n") : "None configured yet."}`),
    );
    return container;
}

async function awaitButton(msg: Message, adminId: string): Promise<string | null> {
    try {
        const i = await msg.awaitMessageComponent({ filter: (i) => i.user.id === adminId, componentType: ComponentType.Button, time: TIMEOUT_MS });
        await i.deferUpdate();
        return i.customId;
    } catch {
        return null;
    }
}

/**
 * Numbered removal list (10/page, numbering is global across pages), racing a chat-typed
 * number against Prev/Next/Back button clicks. Mirrors the pattern used for quota role
 * removal in ezsetup.ts.
 */
async function promptRemoveForward(msg: Message, adminId: string, forwards: BiomeForwardRow[]): Promise<number | null> {
    const channel = msg.channel as GuildTextBasedChannel;
    const pages = Math.max(Math.ceil(forwards.length / FORWARDS_PER_PAGE), 1);
    let page = 0;

    const render = (p: number): MessageEditOptions => {
        const start = p * FORWARDS_PER_PAGE;
        const slice = forwards.slice(start, start + FORWARDS_PER_PAGE);
        const lines = slice.map((f, i) => `${start + i + 1}. ${formatForwardLine(f)}`);

        const container = new ContainerBuilder().setAccentColor(0x5865f2);
        container.addTextDisplayComponents((td) =>
            td.setContent(`**Remove Forward**\nType the number of the forward you want to remove:\n\n${lines.join("\n")}`),
        );
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addTextDisplayComponents((td) => td.setContent(`-# Page ${p + 1} of ${pages}`));

        return {
            flags: MessageFlags.IsComponentsV2,
            components: [
                container,
                new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("fwd-back").setLabel("Back").setStyle(ButtonStyle.Secondary)),
                ...(pages > 1 ? [buildPaginationRow(p, pages)] : []),
            ],
            allowedMentions: NO_ROLE_PINGS,
        };
    };

    await msg.edit(render(page));

    return new Promise((resolve) => {
        let settled = false;
        const settle = (value: number | null) => {
            if (settled) return;
            settled = true;
            buttonCollector.stop();
            textCollector.stop();
            resolve(value);
        };

        const buttonCollector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, componentType: ComponentType.Button, time: TIMEOUT_MS });
        const textCollector = channel.createMessageCollector({ filter: (m) => m.author.id === adminId, time: TIMEOUT_MS });

        buttonCollector.on("collect", async (i) => {
            if (i.customId === "fwd-back") { await i.deferUpdate(); settle(null); return; }
            const next = await handlePaginationButton(i, page, pages, render);
            if (next !== null) page = next;
        });

        textCollector.on("collect", (m) => {
            const n = Number(m.content.trim());
            if (!Number.isInteger(n) || n < 1 || n > forwards.length) {
                m.reply(`Please type a number between 1 and ${forwards.length}.`).catch(() => {});
                return;
            }
            settle(n);
        });

        buttonCollector.on("end", () => settle(null));
        textCollector.on("end", () => settle(null));
    });
}

interface CreatedForward {
    biome: string;
    channelId: string;
    roleId: string | null;
}

/** Single screen with a biome select, a channel select, and an optional role select, confirmed with a button. */
async function promptCreateForward(msg: Message, adminId: string): Promise<CreatedForward | null> {
    const picked: { biome?: string; channelId?: string; roleId?: string } = {};

    const render = () => {
        const biomeMenu = new StringSelectMenuBuilder().setCustomId("fwd-biome").setPlaceholder("Select biome")
            .addOptions(BIOME_SELECTOR_CHOICES.map(({ name, value }) => ({ label: name, value, default: value === picked.biome })));
        const channelMenu = new ChannelSelectMenuBuilder().setCustomId("fwd-channel").setChannelTypes(ChannelType.GuildText).setPlaceholder("Select destination channel");
        if (picked.channelId) channelMenu.setDefaultChannels(picked.channelId);
        const roleMenu = new RoleSelectMenuBuilder().setCustomId("fwd-role").setPlaceholder("Select role to ping (optional)");
        if (picked.roleId) roleMenu.setDefaultRoles(picked.roleId);

        const container = new ContainerBuilder().setAccentColor(0x5865f2);
        container.addTextDisplayComponents((td) =>
            td.setContent("**Create Biome Forward**\nPick a biome (or a whole category, or All), a destination channel, and optionally a role to ping. Role is optional."),
        );

        return {
            flags: MessageFlags.IsComponentsV2 as const,
            components: [
                container,
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(biomeMenu),
                new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channelMenu),
                new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleMenu),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("fwd-confirm").setLabel("Confirm").setStyle(ButtonStyle.Success).setDisabled(!picked.biome || !picked.channelId),
                    new ButtonBuilder().setCustomId("fwd-cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
                ),
            ],
            allowedMentions: NO_ROLE_PINGS,
        };
    };

    await msg.edit(render());

    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, time: TIMEOUT_MS });

        collector.on("collect", async (i) => {
            if (i.customId === "fwd-cancel") { await i.deferUpdate(); collector.stop("cancel"); return; }
            if (i.customId === "fwd-confirm") { await i.deferUpdate(); collector.stop("confirm"); return; }
            if (i.isStringSelectMenu() && i.customId === "fwd-biome") picked.biome = i.values[0];
            if (i.isChannelSelectMenu() && i.customId === "fwd-channel") picked.channelId = i.values[0];
            if (i.isRoleSelectMenu() && i.customId === "fwd-role") picked.roleId = i.values[0];
            await i.update(render());
        });

        collector.on("end", (_collected, reason) => {
            if (reason === "confirm" && picked.biome && picked.channelId) {
                resolve({ biome: picked.biome, channelId: picked.channelId, roleId: picked.roleId ?? null });
            } else {
                resolve(null);
            }
        });
    });
}

/** Shared list + Create/Remove loop. `onExit` decides what ends the loop (Close button in standalone mode, Back/Skip/Cancel in the ezsetup step). */
async function forwardLoop(
    guild: Guild,
    adminId: string,
    msg: Message,
    extraButtons: () => ButtonBuilder[],
    onExtra: (customId: string) => Direction | null,
): Promise<Direction> {
    while (true) {
        const forwards = await getForwardConfigs(guild.id);
        await msg.edit({
            flags: MessageFlags.IsComponentsV2,
            components: [
                listContainer(forwards),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("fwd-add").setLabel("Create").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("fwd-remove").setLabel("Remove").setStyle(ButtonStyle.Danger).setDisabled(forwards.length === 0),
                    ...extraButtons(),
                ),
            ],
            allowedMentions: NO_ROLE_PINGS,
        });

        const choice = await awaitButton(msg, adminId);
        if (!choice) return "timeout";

        const extra = onExtra(choice);
        if (extra) return extra;

        if (choice === "fwd-remove") {
            const index = await promptRemoveForward(msg, adminId, forwards);
            if (index !== null) await removeForwardConfig(guild.id, forwards[index - 1].biome);
            continue;
        }

        if (choice === "fwd-add") {
            const created = await promptCreateForward(msg, adminId);
            if (created) {
                const biomes = resolveBiomeSelector(created.biome);
                for (const biome of biomes) await setForwardConfig(guild.id, biome, created.channelId, created.roleId);
            }
            continue;
        }
    }
}

/** Standalone entry point for `bh-admin forward menu` / bare `!bh-admin forward`. */
export async function runForwardMenu(
    guild: Guild,
    adminId: string,
    respond: (payload: { flags: MessageFlags.IsComponentsV2; components: ContainerBuilder[] }) => Promise<Message>,
): Promise<void> {
    const msg = await respond({ flags: MessageFlags.IsComponentsV2, components: [listContainer([], "Biome Forwards")] });

    const direction = await forwardLoop(
        guild, adminId, msg,
        () => [new ButtonBuilder().setCustomId("fwd-close").setLabel("Close").setStyle(ButtonStyle.Secondary)],
        (customId) => (customId === "fwd-close" ? "cancel" : null),
    );

    if (direction === "timeout") {
        await msg.edit(EmbedFormatter.info("Menu timed out.")).catch(() => {});
        return;
    }

    const forwards = await getForwardConfigs(guild.id);
    await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [listContainer(forwards)], allowedMentions: NO_ROLE_PINGS }).catch(() => {});
}

/** ezsetup wizard step - same Create/Remove loop, with Back/Skip/Cancel instead of Close. */
export async function stepBiomeForwards(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    return forwardLoop(
        guild, adminId, msg,
        () => [
            new ButtonBuilder().setCustomId("fwd-back").setLabel("Back").setStyle(ButtonStyle.Secondary).setDisabled(!canGoBack),
            new ButtonBuilder().setCustomId("fwd-skip").setLabel("Skip").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("fwd-cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
        ],
        (customId) => {
            if (customId === "fwd-back") return "back";
            if (customId === "fwd-skip") return "forward";
            if (customId === "fwd-cancel") return "cancel";
            return null;
        },
    );
}
