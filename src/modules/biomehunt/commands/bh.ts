import {
    ActionRowBuilder, AttachmentBuilder, type ButtonInteraction, ButtonBuilder, ButtonStyle, ComponentType,
    ContainerBuilder, MessageFlags, SeparatorSpacingSize, SlashCommandBuilder,
} from "discord.js";
import type { Guild, GuildMember, Message } from "discord.js";
import { readFileSync } from "fs";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { type ConfirmPayload } from "@/utils/confirm";
import { EmbedFormatter, type FormattedReply, NO_ROLE_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import { applyFlowerToWebhook } from "./adminMemberActions";
import { drawRandomFlower, FLOWER_META, flowerAssetPath } from "../flowers";
import { runUserSetup } from "../guildSetup";
import { isFlagEnabled } from "../repository/flags";
import { adjustUserBalance } from "../repository/rewards";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users";
import { BiomeHuntError, formatSeedsFooter } from "../types";
import { runProfileView } from "./profileViews";

const logger = new Logger("biomehunt.commands.bh");

export default defineCommand({
    name: "bh",
    description: "User commands for biome hunt module",
    category: CommandCategory.UTILITY,
    showOnHelp: true,

    options: new SlashCommandBuilder()
        .addSubcommand((sub) => sub.setName("setup").setDescription("Set up your hunt macro channel."))
        .addSubcommand((sub) =>
            sub.setName("profile").setDescription("View your hunt profile, or someone else's.")
                .addUserOption((o) => o.setName("user").setDescription("Whose profile to view (defaults to yourself)")),
        )
        .addSubcommand((sub) => sub.setName("reroll").setDescription("Reroll your Flower for 50 Seeds.")),
        // .addSubcommand((sub) => sub.setName("history").setDescription("View your recent activity sessions."))
        // .addSubcommand((sub) => sub.setName("leaderboard").setDescription("View the server's activity leaderboard.")),

    async executeAsSlash(interaction, client) {
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({ content: "This command only works in a server.", ephemeral: true });
            return;
        }
        const sub = interaction.options.getSubcommand(true);

        if (sub === "profile") {
            const targetUser = interaction.options.getUser("user");
            const target = targetUser
                ? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
                : (interaction.member as GuildMember);
            if (!target) {
                await interaction.reply({ content: "Could not resolve that member.", ephemeral: true });
                return;
            }
            await interaction.deferReply();
            await runProfileView(interaction.guild.id, target, interaction.user.id, (payload) => interaction.editReply({ ...payload, allowedMentions: NO_ROLE_PINGS }));
            return;
        }

        if (sub === "reroll") {
            await interaction.deferReply();
            await runReroll(client, interaction.guild.id, interaction.user.id, (payload) => interaction.editReply(payload));
            return;
        }

        await interaction.deferReply({ ephemeral: sub === "setup" });
        try {
            const result = await runSubcommand(sub, interaction.guild, interaction.member as GuildMember);
            await interaction.editReply(result);
        } catch (err) {
            await interaction.editReply(EmbedFormatter.error(errorMessage(err)));
        }
    },

    async executeAsPrefix(message, args, client) {
        if (!message.guild || !message.member) {
            await message.reply("This command only works in a server.");
            return;
        }
        const sub = args.getSubcommand();
        if (!sub) {
            await message.reply(EmbedFormatter.info("Usage: `bh <setup|profile>`"));
            return;
        }

        if (sub === "profile") {
            const target = (await args.getMember("user")) ?? message.member;
            await runProfileView(message.guild.id, target, message.author.id, (payload) => message.reply({ ...payload, allowedMentions: NO_ROLE_PINGS }));
            return;
        }

        if (sub === "reroll") {
            await runReroll(client, message.guild.id, message.author.id, (payload) => message.reply(payload));
            return;
        }

        try {
            const result = await runSubcommand(sub, message.guild, message.member);
            await message.reply(result);
        } catch (err) {
            await message.reply(EmbedFormatter.error(errorMessage(err)));
        }
    },
});

async function runSubcommand(sub: string, guild: Guild, member: GuildMember): Promise<FormattedReply> {
    switch (sub) {
        case "setup": {
            const result = await runUserSetup(guild, member);
            return EmbedFormatter.success(`Created: <#${result.channelId}>`);
        }
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${sub}`);
    }
}

const REROLL_COST = 50;
const REROLL_IDLE_MS = 20_000;

const REROLL_CONFIRM_ID = "reroll-confirm";
const REROLL_CANCEL_ID = "reroll-cancel";
const REROLL_AGAIN_ID = "reroll-again";
const REROLL_APPLY_ID = "reroll-apply";

function flowerAttachment(flower: string | null): { files: AttachmentBuilder[]; thumbnailAttachment?: string } {
    if (!flower || !FLOWER_META[flower]) return { files: [] };
    const fileName = `${flower.toLowerCase()}.png`;
    return {
        files: [new AttachmentBuilder(readFileSync(flowerAssetPath(flower)), { name: fileName })],
        thumbnailAttachment: fileName,
    };
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Flower's name as the prominent heading, its rarity as a smaller bold line underneath -
 * name is the point, rarity is context, so name has to read bigger, not the other way around. */
function flowerSectionContent(flower: string | null): string {
    if (!flower || !FLOWER_META[flower]) return "*none yet*";
    return `### ${FLOWER_META[flower].label}\n-# ${capitalize(FLOWER_META[flower].rarity)}`;
}

/**
 * Shared render for every stage of the reroll flow:
 * `-# Roll #N` (tracking line)
 * `## {heading}`
 * Flower name + rarity, with its image as a thumbnail
 * ---
 * `-# 🌱 Seeds: ... · Level ...` (same footer the profile uses, so the balance is always visible
 * while rolling, not just at the very start)
 */
function buildRerollPayload(
    heading: string,
    flower: string | null,
    seeds: number,
    xp: number,
    rollCount: number,
    buttons?: ActionRowBuilder<ButtonBuilder>,
    note?: string,
): ConfirmPayload {
    const { files, thumbnailAttachment } = flowerAttachment(flower);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents((td) => td.setContent(`-# Roll #${rollCount}`));
    container.addTextDisplayComponents((td) => td.setContent(`## ${heading}`));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    const flowerContent = flowerSectionContent(flower);
    if (thumbnailAttachment) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(flowerContent))
                .setThumbnailAccessory((thumb) => thumb.setURL(`attachment://${thumbnailAttachment}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(flowerContent));
    }
    if (note) container.addTextDisplayComponents((td) => td.setContent(`-# ${note}`));

    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents((td) => td.setContent(formatSeedsFooter(seeds, xp)));

    return { flags: MessageFlags.IsComponentsV2, components: buttons ? [container, buttons] : [container], files };
}

function buildConfirmButtons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(REROLL_CONFIRM_ID).setLabel("Reroll").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(REROLL_CANCEL_ID).setLabel("Cancel").setStyle(ButtonStyle.Danger),
    );
}

function buildRollButtons(canRollAgain: boolean): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(REROLL_AGAIN_ID).setEmoji("🎲").setLabel("Roll Again").setStyle(ButtonStyle.Primary).setDisabled(!canRollAgain),
        new ButtonBuilder().setCustomId(REROLL_APPLY_ID).setEmoji("✅").setLabel("Apply Now").setStyle(ButtonStyle.Success),
    );
}

/** Waits for a single button click from `invokerId` on `msg` - resolves the interaction (so the
 * caller acks it) or `null` on idle timeout. One-shot, matching this codebase's `awaitButton`
 * convention (see ezsetup.ts/forwardMenu.ts) rather than a long-lived collector, since each
 * reroll stage needs its own fresh wait. */
function awaitRerollButton(msg: Message, invokerId: string): Promise<ButtonInteraction | null> {
    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: (i) => i.user.id === invokerId,
            time: REROLL_IDLE_MS,
            max: 1,
        });
        collector.on("collect", (i) => resolve(i));
        collector.on("end", (collected) => {
            if (collected.size === 0) resolve(null);
        });
    });
}

/** Discord user ids with a reroll session currently open - guards against a second concurrent
 * `/bh reroll` for the same user, which would otherwise race two independent draw/apply loops
 * against the same webhook (and let two idle timeouts each try to apply their own Flower). */
const activeRerolls = new Set<string>();

/**
 * Self-service paid Flower reroll. Deliberately never calls the actual (rate-limited) webhook
 * edit more than once per session: every "Roll Again" click only redraws and re-renders THIS
 * message client-side, each redraw still costing Seeds like the first one - the real
 * `webhook.edit()` only happens once, on "Apply Now" or on idle timeout (so Seeds already spent
 * are never wasted just because the user walked away).
 */
async function runReroll(
    client: BotClient,
    guildId: string,
    discordUserId: string,
    respond: (payload: ConfirmPayload | FormattedReply) => Promise<Message>,
): Promise<void> {
    if (activeRerolls.has(discordUserId)) {
        await respond(EmbedFormatter.error("You already have a reroll in progress - finish that one first."));
        return;
    }
    activeRerolls.add(discordUserId);
    try {
        await runRerollSession(client, guildId, discordUserId, respond);
    } finally {
        activeRerolls.delete(discordUserId);
    }
}

async function runRerollSession(
    client: BotClient,
    guildId: string,
    discordUserId: string,
    respond: (payload: ConfirmPayload | FormattedReply) => Promise<Message>,
): Promise<void> {
    const [flowersOn, economyOn] = await Promise.all([
        isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"),
        isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"),
    ]);
    if (!flowersOn || !economyOn) {
        await respond(EmbedFormatter.error("Flower rerolls aren't available on this server."));
        return;
    }

    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) {
        await respond(EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."));
        return;
    }
    if (user.seeds < REROLL_COST) {
        await respond(EmbedFormatter.error(`You need ${REROLL_COST} 🌱 Seeds to reroll - you have ${user.seeds}.`));
        return;
    }

    const macroChannel = await getMacroChannelByUserId(user.id);
    if (!macroChannel) {
        await respond(EmbedFormatter.info("You don't have a macro channel yet!\n\nRun `/bh setup` to get started."));
        return;
    }

    let seeds = user.seeds;
    let rollCount = 0;

    // ── Stage 1: confirm, showing the CURRENT flower - nothing is spent yet. ──
    const msg = await respond(
        buildRerollPayload(
            `Reroll your Flower for ${REROLL_COST} 🌱 Seeds?`, macroChannel.flower, seeds, user.xp,
            rollCount, buildConfirmButtons(),
        ),
    );

    const start = await awaitRerollButton(msg, discordUserId);
    if (!start) {
        await msg.edit(EmbedFormatter.warn("Reroll timed out - nothing was spent.")).catch(() => {});
        return;
    }
    if (start.customId === REROLL_CANCEL_ID) {
        await start.update(EmbedFormatter.warn("Reroll cancelled - nothing was spent.")).catch(() => {});
        return;
    }
    await start.deferUpdate().catch(() => {});

    // ── Stage 2: charge, draw, then Roll Again (charges again) / Apply Now, looping until one
    // sticks - either by choice or by idle timeout, which auto-applies the last draw. ──
    const spendOne = async (): Promise<boolean> => {
        const fresh = await getUserByDiscordId(guildId, discordUserId);
        if (!fresh || fresh.seeds < REROLL_COST) return false;
        await adjustUserBalance(null, user.id, -REROLL_COST, 0);
        seeds = fresh.seeds - REROLL_COST;
        rollCount++;
        return true;
    };

    if (!(await spendOne())) {
        await msg.edit(EmbedFormatter.error("You no longer have enough Seeds.")).catch(() => {});
        return;
    }
    let drawn = drawRandomFlower();

    while (true) {
        await msg.edit(
            buildRerollPayload(
                "🎲 New Flower!", drawn, seeds, user.xp, rollCount, buildRollButtons(seeds >= REROLL_COST),
                `If you don't pick one within ${REROLL_IDLE_MS / 1000}s, this Flower is applied automatically.`,
            ),
        ).catch(() => {});

        const click = await awaitRerollButton(msg, discordUserId);

        if (click && click.customId === REROLL_AGAIN_ID) {
            await click.deferUpdate().catch(() => {});
            if (!(await spendOne())) continue; // button is disabled once this can't succeed, but stay safe
            drawn = drawRandomFlower();
            continue;
        }

        // Apply Now, or idle timeout - either way, commit what's currently shown.
        if (click) await click.deferUpdate().catch(() => {});
        try {
            await applyFlowerToWebhook(client, user.id, drawn);
        } catch (err) {
            const text = err instanceof BiomeHuntError ? err.message : "Something went wrong applying your Flower.";
            await msg.edit(EmbedFormatter.error(text)).catch(() => {});
            return;
        }
        await msg.edit(buildRerollPayload("✅ Flower applied!", drawn, seeds, user.xp, rollCount)).catch(() => {});
        return;
    }
}

function errorMessage(err: unknown): string {
    if (err instanceof BiomeHuntError) return err.message;
    logger.error(err instanceof Error ? err : new Error(String(err)));
    return getFailureQuip();
}
