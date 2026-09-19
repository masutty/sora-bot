import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import type { Guild, GuildMember, Message } from "discord.js";
import { readFileSync } from "fs";
import type { BotClient } from "@/core/BotClient";
import { defineCommand } from "@/define";
import { CommandCategory } from "@/types";
import { confirmAction, type ConfirmPayload } from "@/utils/confirm";
import { EmbedFormatter, type FormattedReply } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getFailureQuip } from "@/utils/quips";
import { applyFlowerReroll } from "./adminMemberActions";
import { FLOWER_META, flowerAssetPath } from "../flowers";
import { runUserSetup } from "../guildSetup";
import { isFlagEnabled } from "../repository/flags";
import { adjustUserBalance } from "../repository/rewards";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users";
import { BiomeHuntError } from "../types";
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
            await runProfileView(interaction.guild.id, target, interaction.user.id, (payload) => interaction.editReply(payload));
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
            await runProfileView(message.guild.id, target, message.author.id, (payload) => message.reply(payload));
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

async function runReroll(
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

    const currentFlower = macroChannel.flower;
    const files: AttachmentBuilder[] = [];
    let thumbnailAttachment: string | undefined;
    if (currentFlower && FLOWER_META[currentFlower]) {
        const fileName = `${currentFlower.toLowerCase()}.png`;
        files.push(new AttachmentBuilder(readFileSync(flowerAssetPath(currentFlower)), { name: fileName }));
        thumbnailAttachment = fileName;
    }

    const currentFlowerLabel = currentFlower && FLOWER_META[currentFlower]
        ? `${FLOWER_META[currentFlower].label} (${FLOWER_META[currentFlower].rarity})`
        : "none yet";

    await confirmAction({
        invokerId: discordUserId,
        title: `Reroll your Flower for ${REROLL_COST} 🌱 Seeds?`,
        fields: [
            { label: "Current Flower", value: currentFlowerLabel },
            { label: "Your Seeds", value: String(user.seeds) },
        ],
        files,
        thumbnailAttachment,
        send: respond,
        onConfirm: async (): Promise<FormattedReply> => {
            const fresh = await getUserByDiscordId(guildId, discordUserId);
            if (!fresh || fresh.seeds < REROLL_COST) {
                return EmbedFormatter.error("You no longer have enough Seeds.");
            }
            await adjustUserBalance(null, user.id, -REROLL_COST, 0);
            const { flower } = await applyFlowerReroll(client, user.id);
            return EmbedFormatter.success(`Flower rerolled: **${FLOWER_META[flower].label}** (${FLOWER_META[flower].rarity}).`);
        },
    });
}

function errorMessage(err: unknown): string {
    if (err instanceof BiomeHuntError) return err.message;
    logger.error(err instanceof Error ? err : new Error(String(err)));
    return getFailureQuip();
}
