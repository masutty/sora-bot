import { SlashCommandBuilder, type SlashCommandOptionsOnlyBuilder } from "discord.js";
import { requireSnowflake } from "@/core/command/command-args";
import { type CommandDefinition, defineCommand, type GuildCommandContext } from "@/define";
import { CommandCategory } from "@/types";
import { formatTime } from "@/utils/format";
import * as casesRepo from "../repository/cases.repository";
import * as settingsRepo from "../repository/settings.repository";
import type { CaseService } from "../services/case.service";
import { normalizeCaseId } from "../services/case-id";
import { assertBotCanClear, type ClearChannel, clearCommandMessages } from "../services/clear";
import { splitDuration, splitWeight } from "../services/parse-args";
import { assertCanModerate, canManageSettings, canModerate, type ModAction } from "../services/permission";
import { caseService } from "../services/runtime";
import { settings } from "../settings";
import { type CaseRow, ModerationError } from "../types";
import { type Confirmation, confirmation, plainReply } from "../views/case.render";
import { caseView } from "../views/case.view";
import { casesView } from "../views/cases.view";
import { modstatsText } from "../views/modstats.render";
import { settingsView } from "../views/settings.view";
import { warnsText } from "../views/warns.render";

type Builder = SlashCommandOptionsOnlyBuilder;

/** What the commands need beyond the service, injected so their tests never hit the database. */
export interface ModCommandDeps {
    service: CaseService;
    repo: Pick<typeof casesRepo, "getCase" | "listEvents" | "listUserCases" | "countUserCases" | "activeWarns" | "staffStats"> &
        Pick<typeof settingsRepo, "getSettings" | "updateSettings" | "getThresholds" | "replaceThresholds">;
}

export const defaultDeps = (ctx: GuildCommandContext): ModCommandDeps => ({
    service: caseService(ctx.client),
    repo: { ...casesRepo, ...settingsRepo },
});

// ─── Argument helpers ─────────────────────────────────────────────────────────

const userId = async (ctx: GuildCommandContext): Promise<string> => {
    const user = await ctx.args.getUser("user");
    if (!user) throw new ModerationError("Missing required argument: `user`");
    return user.id;
};

const caseId = (ctx: GuildCommandContext, name = "case"): string => {
    const id = normalizeCaseId(ctx.args.getString(name, true));
    if (!id) throw new ModerationError("That is not a Case ID.");
    return id;
};

const reasonOf = (ctx: GuildCommandContext): string | undefined => ctx.args.getString("reason") || undefined;

/** A duration with a unit (`30m`, `1h30m`, `7d`); anything else is refused. */
function requireDuration(text: string): number {
    const split = splitDuration(text);
    if (split.seconds === null || split.reason !== "") throw new ModerationError("Duration needs a unit, like 30m, 1h30m or 7d.");
    return split.seconds;
}

/** Slash has separate options; prefix has `weight:N` or a leading `Nx` in the reason text (unless `reason:` was named). */
function weightAndReason(ctx: GuildCommandContext): { weight: number; reason: string | undefined } {
    const text = ctx.args.getString("reason") ?? "";
    const named = ctx.args.getInteger("weight");
    const parseText = ctx.raw.kind === "prefix" && named === null && !ctx.args.isNamed("reason");
    const split = parseText ? splitWeight(text) : { weight: named ?? 1, reason: text };
    if (split.weight < 1) throw new ModerationError("Weight must be 1 or more.");
    return { weight: split.weight, reason: split.reason || undefined };
}

/** Slash has separate options; prefix has `duration:X` or a leading duration in the reason text (unless `reason:` was named). */
function durationAndReason(ctx: GuildCommandContext): { durationS: number | null; reason: string | undefined } {
    const text = ctx.args.getString("reason") ?? "";
    const named = ctx.args.getString("duration");
    const parseText = ctx.raw.kind === "prefix" && named === null && !ctx.args.isNamed("reason");
    const split = parseText ? splitDuration(text) : { seconds: named === null ? null : requireDuration(named), reason: text };
    return { durationS: split.seconds, reason: split.reason || undefined };
}

/** The confirmation: ephemeral on slash (the answer is for the moderator; the Case Channel holds the record). */
async function say(ctx: GuildCommandContext, text: string): Promise<void> {
    await ctx.reply(plainReply(text), { ephemeral: ctx.mode === "slash" });
}

/** What an Auto-Punishment did, for the warn confirmation: "Auto-Punishment muted them too". */
const AUTO_DONE: Partial<Record<CaseRow["kind"], string>> = { mute: "muted", kick: "kicked", ban: "banned" };

/** The confirmation of an action. */
async function done(ctx: GuildCommandContext, c: Confirmation): Promise<void> {
    await ctx.reply(confirmation(c), { ephemeral: ctx.mode === "slash" });
}

/** The confirmation of a case just made: its own reason and DM state. */
const made = (ctx: GuildCommandContext, summary: string, row: CaseRow, notes?: string[]) =>
    done(ctx, { summary, caseId: row.id, reason: row.reason, dmFailed: row.dm_delivered === false, notes });

/** The confirmation of revoked cases: the revoked ones are shown, with the reason of the revoking. */
const undid = (ctx: GuildCommandContext, summary: string, rows: CaseRow[], reason: string | undefined) =>
    done(ctx, { summary, caseId: rows.map((r) => r.id).join("`, `") || null, reason: reason ?? settings.defaultReason });

async function start(ctx: GuildCommandContext): Promise<void> {
    await ctx.defer({ ephemeral: ctx.mode === "slash" });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const ids = (rows: { id: string }[]) => rows.map((r) => `\`${r.id}\``).join(", ");

export const handlers = {
    async warn(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const { weight, reason } = weightAndReason(ctx);
        const out = await service.warn({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, reason, weight });
        const notes = [
            ...(out.auto ? [`Auto-Punishment ${AUTO_DONE[out.auto.kind] ?? out.auto.kind} them too (\`${out.auto.id}\`).`] : []),
            ...(out.autoSkipped ? [out.autoSkipped] : []),
        ];
        await made(ctx, `**Warned** <@${user}>`, out.case, notes);
    },

    async unwarn(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        await start(ctx);
        const out = await service.unwarn({ guildId: ctx.guild.id, caseId: caseId(ctx), by: ctx.user.id, reason: reasonOf(ctx) });
        const notes = out.undone.length > 0 ? [`Also revoked: ${ids(out.undone)}`] : [];
        await done(ctx, {
            summary: `**Unwarned** <@${out.case.user_id}>`,
            caseId: out.case.id,
            reason: out.case.end_note ?? settings.defaultReason,
            notes,
        });
    },

    async warns(ctx: GuildCommandContext, { repo }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const [warns, ladder] = await Promise.all([repo.activeWarns(ctx.guild.id, user, new Date()), repo.getThresholds(ctx.guild.id)]);
        await say(ctx, warnsText(user, warns, ladder));
    },

    async mute(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        const durationS = requireDuration(ctx.args.getString("duration", true));
        await start(ctx);
        const row = await service.mute({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, reason: reasonOf(ctx), durationS });
        await made(ctx, `**Muted** <@${user}> for ${formatTime(durationS)}`, row);
    },

    async unmute(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const rows = await service.unmute({ guildId: ctx.guild.id, userId: user, by: ctx.user.id, reason: reasonOf(ctx) });
        await undid(ctx, `**Unmuted** <@${user}>`, rows, reasonOf(ctx));
    },

    async temprole(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        const role = await ctx.args.getRole("role");
        if (!role) throw new ModerationError("Missing required argument: `role`");
        if (ctx.args.getSubcommand() === "remove") {
            await start(ctx);
            const rows = await service.untemprole({
                guildId: ctx.guild.id,
                userId: user,
                roleId: role.id,
                by: ctx.user.id,
                reason: reasonOf(ctx),
            });
            await undid(ctx, `**Removed** <@&${role.id}> from <@${user}>`, rows, reasonOf(ctx));
            return;
        }
        const durationS = requireDuration(ctx.args.getString("duration", true));
        await start(ctx);
        const row = await service.temprole({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, durationS, roleId: role.id });
        await made(ctx, `**Added** <@&${role.id}> to <@${user}> for ${formatTime(durationS)}`, row);
    },

    async kick(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const row = await service.kick({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, reason: reasonOf(ctx) });
        await made(ctx, `**Kicked** <@${user}>`, row);
    },

    async ban(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const { durationS, reason } = durationAndReason(ctx);
        const row = await service.ban({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, reason, durationS });
        await made(ctx, `**Banned** <@${user}> ${durationS === null ? "permanently" : `for ${formatTime(durationS)}`}`, row);
    },

    async softban(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = await userId(ctx);
        await start(ctx);
        const row = await service.softban({ guildId: ctx.guild.id, userId: user, moderatorId: ctx.user.id, reason: reasonOf(ctx) });
        await made(ctx, `**Softbanned** <@${user}>`, row);
    },

    async unban(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const user = requireSnowflake(ctx.args.getString("id", true));
        await start(ctx);
        const rows = await service.unban({ guildId: ctx.guild.id, userId: user, by: ctx.user.id, reason: reasonOf(ctx) });
        await undid(ctx, `**Unbanned** <@${user}>`, rows, reasonOf(ctx));
    },

    async cases(ctx: GuildCommandContext, { repo }: ModCommandDeps) {
        const user = await userId(ctx);
        const guildId = ctx.guild.id;
        await ctx.open(
            casesView({
                userId: user,
                count: () => repo.countUserCases(guildId, user),
                list: (limit, offset) => repo.listUserCases(guildId, user, { limit, offset }),
            }),
            undefined,
            { ephemeral: ctx.mode === "slash" },
        );
    },

    async case(ctx: GuildCommandContext, { repo, service }: ModCommandDeps) {
        const id = caseId(ctx, "id");
        await start(ctx);
        const row = await repo.getCase(ctx.guild.id, id);
        if (!row) throw new ModerationError("No Case with that ID.");
        const guildId = ctx.guild.id;
        await ctx.open(
            caseView({
                guildId,
                row,
                service,
                canRevoke: async (id) => canModerate(await ctx.guild.members.fetch(id), "moderate", await repo.getSettings(guildId)),
                reload: async () => ({ row: (await repo.getCase(guildId, id)) ?? row, events: await repo.listEvents(id) }),
            }),
            undefined,
            { ephemeral: ctx.mode === "slash" },
        );
    },

    async reason(ctx: GuildCommandContext, { service }: ModCommandDeps) {
        const id = caseId(ctx, "id");
        await start(ctx);
        const row = await service.editReason({
            guildId: ctx.guild.id,
            caseId: id,
            reason: ctx.args.getString("text", true),
            by: ctx.user.id,
        });
        await say(ctx, `Updated the reason of \`${row.id}\`.`);
    },

    async stats(ctx: GuildCommandContext, { repo }: ModCommandDeps) {
        const staff = (await ctx.args.getUser("staff"))?.id ?? null;
        await start(ctx);
        const day = 86_400_000;
        const windows = [
            { label: "7 days", since: new Date(Date.now() - 7 * day) },
            { label: "30 days", since: new Date(Date.now() - 30 * day) },
            { label: "All time", since: null },
        ];
        const stats = await Promise.all(
            windows.map(async ({ label, since }) => ({ label, rows: await repo.staffStats(ctx.guild.id, staff, since) })),
        );
        await say(ctx, modstatsText(staff, stats));
    },

    async settings(ctx: GuildCommandContext, { repo }: ModCommandDeps) {
        await ctx.open(settingsView({ guildId: ctx.guild.id, ...repo }), undefined);
    },

    /** Prefix only: the reply is public and removed after a few seconds, and the invocation itself goes with the rest. */
    async mclear(ctx: GuildCommandContext) {
        if (ctx.raw.kind !== "prefix") throw new ModerationError("`mclear` only works as a prefix command.");
        const { channel } = ctx.raw.message;
        if (!("bulkDelete" in channel)) throw new ModerationError("I can't clear messages here.");
        const botId = (ctx.client.user as { id: string }).id;
        assertBotCanClear(channel.permissionsFor(ctx.guild.members.me ?? botId));
        const count = await clearCommandMessages(channel as unknown as ClearChannel, {
            prefix: ctx.invokePrefix,
            commandNames: COMMAND_NAMES,
            botId,
            now: Date.now(),
        });
        const note = await channel.send(`Cleared ${count} ${count === 1 ? "message" : "messages"}.`);
        setTimeout(() => void note.delete().catch(() => {}), CLEAR_NOTE_MS).unref?.();
    },
};

// ─── Definitions ──────────────────────────────────────────────────────────────

const CLEAR_NOTE_MS = 5000;

const user = (b: Builder, name = "user", description = "Member", required = true) =>
    b.addUserOption((o) => o.setName(name).setDescription(description).setRequired(required));
const text = (b: Builder, name: string, description: string, required = false) =>
    b.addStringOption((o) => o.setName(name).setDescription(description).setRequired(required));

const reason = (b: Builder) => b.addStringOption((o) => o.setName("reason").setDescription("Why").setMaxLength(settings.maxReason));
const caseOption = (b: Builder, name = "case") => text(b, name, "Case ID", true);

interface Spec {
    name: string;
    description: string;
    action: ModAction;
    /** The handler to run when it is not the one named like the command. */
    handler?: keyof typeof handlers;
    modes?: "prefix";
    build: (b: SlashCommandBuilder) => unknown;
    /** Prefix-only: options that are never filled by position. */
    namedOnly?: string[];
}

const casesSpec: Spec = { name: "cases", description: "List the cases of a member.", action: "moderate", build: (b) => user(b) };

const SPECS: Spec[] = [
    {
        name: "warn",
        description: "Warn a member.",
        action: "moderate",
        namedOnly: ["weight"],
        build: (b) => {
            user(b);
            b.addIntegerOption((o) =>
                o.setName("weight").setDescription("How many warns this counts as").setMinValue(1).setMaxValue(settings.maxWeight),
            );
            reason(b);
        },
    },
    { name: "unwarn", description: "Revoke a warn.", action: "moderate", build: (b) => reason(caseOption(b)) },
    { name: "warns", description: "Show the active warns of a member.", action: "moderate", build: (b) => user(b) },
    {
        name: "mute",
        description: "Time a member out.",
        action: "moderate",
        build: (b) => reason(text(user(b), "duration", "30m, 1h30m, 7d (28d at most)", true)),
    },
    { name: "unmute", description: "Lift a member's timeout.", action: "moderate", build: (b) => reason(user(b)) },
    {
        name: "temprole",
        description: "Give a role for a while.",
        action: "moderate",
        build: (b) => {
            b.addSubcommand((sub) =>
                sub
                    .setName("add")
                    .setDescription("Give a role for a while.")
                    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
                    .addStringOption((o) => o.setName("duration").setDescription("30m, 1h30m, 7d").setRequired(true))
                    .addRoleOption((o) => o.setName("role").setDescription("Role to give").setRequired(true)),
            ).addSubcommand((sub) =>
                sub
                    .setName("remove")
                    .setDescription("Take a temporary role away early.")
                    .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
                    .addRoleOption((o) => o.setName("role").setDescription("Role to remove").setRequired(true))
                    .addStringOption((o) => o.setName("reason").setDescription("Why").setMaxLength(settings.maxReason)),
            );
        },
    },
    { name: "kick", description: "Kick a member.", action: "kick", build: (b) => reason(user(b)) },
    {
        name: "ban",
        description: "Ban a member or a user ID.",
        action: "ban",
        namedOnly: ["duration"],
        build: (b) => reason(text(user(b), "duration", "Like 30m, 1h30m or 7d, empty for permanent")),
    },
    { name: "softban", description: "Ban and unban to delete a day of messages.", action: "ban", build: (b) => reason(user(b)) },
    { name: "unban", description: "Unban a user.", action: "ban", build: (b) => reason(text(b, "id", "User ID", true)) },
    casesSpec,
    { ...casesSpec, name: "modlogs", handler: "cases" },
    { name: "case", description: "Show a case and its history.", action: "moderate", build: (b) => caseOption(b, "id") },
    {
        name: "reason",
        description: "Change the reason of a case.",
        action: "moderate",
        build: (b) =>
            caseOption(b, "id").addStringOption((o) =>
                o.setName("text").setDescription("New reason").setRequired(true).setMaxLength(settings.maxReason),
            ),
    },
    {
        name: "mclear",
        description: "Delete recent moderation commands and my replies.",
        action: "moderate",
        modes: "prefix",
        build: () => {},
    },
];

const COMMAND_NAMES: ReadonlySet<string> = new Set([...SPECS.map((s) => s.name), "moderator"]);

/** The moderation permission of the member, read when the command runs (Discord's own command permissions are not used). */
async function enforce(ctx: GuildCommandContext, deps: ModCommandDeps, action: ModAction): Promise<void> {
    assertCanModerate(ctx.member, action, await deps.repo.getSettings(ctx.guild.id));
}

function command(spec: Spec): CommandDefinition {
    const options = new SlashCommandBuilder();
    spec.build(options);
    const handler = handlers[spec.handler ?? (spec.name as keyof typeof handlers)];
    return defineCommand({
        name: spec.name,
        description: spec.description,
        category: CommandCategory.MODERATION,
        showOnHelp: true,
        guildOnly: true,
        modes: spec.modes,
        prefixNamedOnly: spec.namedOnly,
        options,
        run: async (ctx) => {
            const deps = defaultDeps(ctx);
            await enforce(ctx, deps, spec.action);
            await handler(ctx, deps);
        },
    });
}

/** `/moderator settings` and `/moderator stats` - a command of its own so the name stays free of a verb. */
const moderator = defineCommand({
    name: "moderator",
    description: "Moderation settings.",
    category: CommandCategory.MODERATION,
    showOnHelp: true,
    guildOnly: true,
    onMissingSubcommand: "run",
    options: new SlashCommandBuilder()
        .addSubcommand((s) => s.setName("settings").setDescription("Open the moderation settings."))
        .addSubcommand((s) =>
            s
                .setName("stats")
                .setDescription("Show moderation activity.")
                .addUserOption((o) => o.setName("staff").setDescription("Staff member")),
        ),
    run: async (ctx) => {
        const deps = defaultDeps(ctx);
        if (ctx.args.getSubcommand() === "stats") {
            await enforce(ctx, deps, "moderate");
            return handlers.stats(ctx, deps);
        }
        if (!canManageSettings(ctx.member)) throw new ModerationError("You need Administrator or Manage Server to do that.");
        return handlers.settings(ctx, deps);
    },
});

export const moderationCommands: CommandDefinition[] = [...SPECS.map(command), moderator];
