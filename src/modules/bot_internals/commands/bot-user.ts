import { MessageFlags, type SlashCommandBuilder, type User } from "discord.js";
import { banFromBot, unbanFromBot } from "@/core/moderation/bot-ban";
import { cachedBan } from "@/core/moderation/bot-ban-cache";
import { getBotNotes, getBotPunishments, insertBotNote } from "@/database/bot-moderation.repository";
import { type CommandContext, tabs, UserFacingError, type ViewPayload } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { type AccountInfo, buildAccountContainer, buildNotesContainer, buildPunishmentsContainer } from "../views/bot-user.view";

/** The `/bot` subcommands about one user - bot-wide moderation, not any server's. */
export const USER_SUBCOMMANDS = new Set(["ban", "unban", "info", "note", "notes"]);

const HISTORY_LIMIT = 15;
const NOTES_LIMIT = 15;
const NOTE_MAX_CHARS = 1000;
const REASON_MAX_CHARS = 500;

/** Adds the user subcommands to `/bot`'s builder. */
export function addUserSubcommands<T extends Pick<SlashCommandBuilder, "addSubcommand">>(builder: T): T {
    builder
        .addSubcommand((s) =>
            s
                .setName("ban")
                .setDescription("Ban a user from the whole bot - every command and button answers with the ban.")
                .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
                .addStringOption((o) => o.setName("reason").setDescription("Shown to the user").setMaxLength(REASON_MAX_CHARS)),
        )
        .addSubcommand((s) =>
            s
                .setName("unban")
                .setDescription("Lift a user's bot ban.")
                .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("info")
                .setDescription("A user's account and their bot punishments.")
                .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
        )
        .addSubcommand((s) =>
            s
                .setName("note")
                .setDescription("Add a private note about a user.")
                .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
                .addStringOption((o) => o.setName("note").setDescription("The note").setRequired(true).setMaxLength(NOTE_MAX_CHARS)),
        )
        .addSubcommand((s) =>
            s
                .setName("notes")
                .setDescription("A user's private notes.")
                .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true)),
        );
    return builder;
}

const v2 = (container: ReturnType<typeof buildNotesContainer>): ViewPayload => ({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PINGS,
});

async function requireUser(ctx: CommandContext): Promise<User> {
    const user = await ctx.args.getUser("user");
    if (!user) throw new UserFacingError("Missing required argument: user");
    return user;
}

/** `/bot ban|unban|info|note|notes <user>` - the caller already checked it's a bot owner. */
export async function runUserSubcommand(ctx: CommandContext, sub: string): Promise<void> {
    const user = await requireUser(ctx);
    await ctx.defer({ ephemeral: true });

    switch (sub) {
        case "ban": {
            const reason = ctx.args.getString("reason")?.trim() || null;
            const added = await banFromBot(user.id, reason, ctx.user.id);
            await ctx.reply(
                added
                    ? EmbedFormatter.success(`<@${user.id}> is now banned from the bot.${reason ? `\nReason: ${reason}` : ""}`)
                    : EmbedFormatter.info(`<@${user.id}> is already banned. Unban them first to change the reason.`),
            );
            return;
        }
        case "unban": {
            const removed = await unbanFromBot(user.id, ctx.user.id);
            await ctx.reply(
                removed
                    ? EmbedFormatter.success(`<@${user.id}> can use the bot again.`)
                    : EmbedFormatter.info(`<@${user.id}> is not banned.`),
            );
            return;
        }
        case "note": {
            const note = await insertBotNote(user.id, ctx.args.getString("note", true).trim(), ctx.user.id);
            await ctx.reply(EmbedFormatter.success(`Note \`#${note.id}\` added to <@${user.id}>.`));
            return;
        }
        case "notes":
            await ctx.reply(v2(buildNotesContainer(user.id, await getBotNotes(user.id, NOTES_LIMIT))));
            return;
        case "info":
            return runInfo(ctx, user);
    }
}

interface InfoState {
    tab: string;
    account: AccountInfo;
}

/** `/bot info` - two tabs: the account, and the bot punishments (current ban + history). */
async function runInfo(ctx: CommandContext, user: User): Promise<void> {
    const fetched = await user.fetch().catch(() => user);
    const account: AccountInfo = {
        id: fetched.id,
        username: fetched.username,
        displayName: fetched.globalName ?? fetched.username,
        avatarUrl: fetched.displayAvatarURL({ size: 256 }),
        createdAt: fetched.createdAt,
        bot: fetched.bot,
        mutualServers: ctx.client.guilds.cache.filter((g) => g.members.cache.has(fetched.id)).size,
    };
    const history = await getBotPunishments(user.id, HISTORY_LIMIT);

    await ctx.open(
        tabs<InfoState, void>({
            name: "bot_internals.user-info",
            initial: () => ({ tab: "account", account }),
            tabs: [
                { key: "account", label: "Account" },
                { key: "punishments", label: "Punishments" },
            ],
            // Read live on every render - a ban/unban from another command shows up on the next tab click.
            renderTab: (s) => ({
                payload: v2(
                    s.tab === "account"
                        ? buildAccountContainer(s.account, cachedBan(s.account.id))
                        : buildPunishmentsContainer(cachedBan(s.account.id), history),
                ),
            }),
        }),
        undefined,
    );
}
