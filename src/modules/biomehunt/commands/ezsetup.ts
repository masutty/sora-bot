import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ComponentType,
    EmbedBuilder, ModalBuilder, RoleSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import type { Guild, GuildTextBasedChannel, Message } from "discord.js";
import { EmbedFormatter, formatTime } from "@/utils/format";
import { isGuildReady, getOrCreateGuildConfig, getEnabledCategories, getGuildRoles } from "../repository/guilds";
import { getGuildBadgeRoles } from "../repository/badges";
import { isFlagEnabled, setGuildFlag } from "../repository/flags";
import { getQuotaRolesForGuild } from "../repository/quotaRoles";
import { activityDeleteAction, activitySetAction } from "./adminActivityActions";
import { badgesSetAction } from "./adminBadgeActions";
import { addCategoryAction, disableCounterAction, setCounterChannelAction, setRolesAction, showConfig } from "./adminConfigActions";
import { quotasCreateAction, removeQuotaRoleAction } from "./adminQuotaActions";
import { stepBiomeForwards } from "./forwardMenu";
import { ALL_BADGES, BADGE_META, type Badge, type QuotaRoleMode, type QuotaRoleRow } from "../types";

const STEP_TIMEOUT_MS = 5 * 60_000;

/** What the outer step driver should do next. */
type Direction = "forward" | "back" | "cancel" | "timeout";

type StepResult<T> =
    | { kind: "ok"; value: T }
    | { kind: "skip" }
    | { kind: "back" }
    | { kind: "cancel" }
    | { kind: "timeout" };

function isTerminal(r: StepResult<unknown>): r is { kind: "cancel" | "timeout" } {
    return r.kind === "cancel" || r.kind === "timeout";
}

function terminalMessage(kind: "cancel" | "timeout"): string {
    return kind === "cancel" ? "Setup cancelled." : "Setup timed out.";
}

// ─── Button helpers ─────────────────────────────────────────────────────────

function backButton(): ButtonBuilder {
    return new ButtonBuilder().setCustomId("ez-back").setLabel("Back").setStyle(ButtonStyle.Secondary);
}

function skipButton(label = "Skip"): ButtonBuilder {
    return new ButtonBuilder().setCustomId("ez-skip").setLabel(label).setStyle(ButtonStyle.Secondary);
}

function cancelButton(): ButtonBuilder {
    return new ButtonBuilder().setCustomId("ez-cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger);
}

/** Back (leftmost, disabled if `canGoBack` is false) ... middle buttons ... Skip, Cancel (rightmost). */
function navRow(canGoBack: boolean, skipLabel: string, ...middle: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        backButton().setDisabled(!canGoBack),
        ...middle,
        skipButton(skipLabel),
        cancelButton(),
    );
}

function stepEmbed(title: string, description: string): EmbedBuilder {
    return new EmbedBuilder().setColor(0x5865f2).setTitle(`bh-ezsetup - ${title}`).setDescription(description);
}

function formatQuotaRoleLine(qr: QuotaRoleRow): string {
    const modeLabel = qr.mode === "F" ? "Fixed" : "RW";
    const hours = qr.quota_target_seconds / 3600;
    const durationNote = qr.mode === "F" ? `, ${qr.access_duration_days}d access` : "";
    return `<@&${qr.role_id}> - ${modeLabel} ${hours}h/${qr.quota_window_hours}h${durationNote}`;
}

/** Plain summary of currently configured quota roles (no numbering — used on the main gate screen). */
function formatQuotaRoleList(roles: QuotaRoleRow[]): string {
    if (roles.length === 0) return "None configured yet.";
    return roles.map(formatQuotaRoleLine).join("\n");
}

/** Numbered summary, used on the removal screen so the admin can reference a role by its number. */
function formatNumberedQuotaRoleList(roles: QuotaRoleRow[]): string {
    return roles.map((r, i) => `${i + 1}. ${formatQuotaRoleLine(r)}`).join("\n");
}

/** Renders `\- **Label**: <@&role>` (or `role_not_set`) — the leading `\-` is escaped so Discord doesn't turn it into a bullet. */
function roleLine(label: string, roleId: string | null): string {
    return `\\- **${label}**: ${roleId ? `<@&${roleId}>` : "`role_not_set`"}`;
}

async function finish(msg: Message, text: string): Promise<void> {
    await msg.edit({ embeds: [EmbedFormatter.info(text)], components: [] }).catch(() => {});
}

// ─── Low-level input waiters ────────────────────────────────────────────────

/** Waits for a single button click on `msg` from `adminId`. */
async function awaitButton(msg: Message, adminId: string): Promise<StepResult<string>> {
    try {
        const i = await msg.awaitMessageComponent({
            filter: (i) => i.user.id === adminId,
            componentType: ComponentType.Button,
            time: STEP_TIMEOUT_MS,
        });
        await i.deferUpdate();
        if (i.customId === "ez-cancel") return { kind: "cancel" };
        if (i.customId === "ez-skip") return { kind: "skip" };
        if (i.customId === "ez-back") return { kind: "back" };
        return { kind: "ok", value: i.customId };
    } catch {
        return { kind: "timeout" };
    }
}

/** Waits for a multi-select channel picker (used for macro categories / counter channel). */
async function awaitChannelSelect(msg: Message, adminId: string): Promise<StepResult<string[]>> {
    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, time: STEP_TIMEOUT_MS, max: 1 });
        collector.on("collect", async (i) => {
            await i.deferUpdate();
            if (i.customId === "ez-cancel") { resolve({ kind: "cancel" }); return; }
            if (i.customId === "ez-skip") { resolve({ kind: "skip" }); return; }
            if (i.customId === "ez-back") { resolve({ kind: "back" }); return; }
            if (i.isChannelSelectMenu()) resolve({ kind: "ok", value: i.values });
        });
        collector.on("end", (collected) => {
            if (collected.size === 0) resolve({ kind: "timeout" });
        });
    });
}

/** Waits for all three active/idle/inactive role selects to be filled in. */
async function awaitRoleTriplet(msg: Message, adminId: string): Promise<StepResult<{ active: string; idle: string; inactive: string }>> {
    const picked: Partial<Record<"active" | "idle" | "inactive", string>> = {};
    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, time: STEP_TIMEOUT_MS });
        collector.on("collect", async (i) => {
            await i.deferUpdate();
            if (i.customId === "ez-cancel") { collector.stop("cancel"); return; }
            if (i.customId === "ez-skip") { collector.stop("skip"); return; }
            if (i.customId === "ez-back") { collector.stop("back"); return; }
            if (i.isRoleSelectMenu()) {
                const key = i.customId.replace("ez-role-", "") as "active" | "idle" | "inactive";
                picked[key] = i.values[0];
                if (picked.active && picked.idle && picked.inactive) collector.stop("done");
            }
        });
        collector.on("end", (_collected, reason) => {
            if (reason === "done") resolve({ kind: "ok", value: { active: picked.active!, idle: picked.idle!, inactive: picked.inactive! } });
            else if (reason === "cancel") resolve({ kind: "cancel" });
            else if (reason === "skip") resolve({ kind: "skip" });
            else if (reason === "back") resolve({ kind: "back" });
            else resolve({ kind: "timeout" });
        });
    });
}

/** Waits for any subset of the three badge role selects to be filled in, resolving once the admin clicks a nav button. */
async function awaitBadgeRoleSelects(msg: Message, adminId: string): Promise<StepResult<Partial<Record<Badge, string>>>> {
    const picked: Partial<Record<Badge, string>> = {};
    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, time: STEP_TIMEOUT_MS });
        collector.on("collect", async (i) => {
            if (i.customId === "ez-cancel") { await i.deferUpdate(); collector.stop("cancel"); return; }
            if (i.customId === "ez-skip") { await i.deferUpdate(); collector.stop("skip"); return; }
            if (i.customId === "ez-back") { await i.deferUpdate(); collector.stop("back"); return; }
            if (i.customId === "ez-done") { await i.deferUpdate(); collector.stop("done"); return; }
            if (i.isRoleSelectMenu()) {
                await i.deferUpdate();
                const key = i.customId.replace("ez-badge-", "") as Badge;
                picked[key] = i.values[0];
            }
        });
        collector.on("end", (_collected, reason) => {
            if (reason === "done") resolve({ kind: "ok", value: picked });
            else if (reason === "cancel") resolve({ kind: "cancel" });
            else if (reason === "skip") resolve({ kind: "skip" });
            else if (reason === "back") resolve({ kind: "back" });
            else resolve({ kind: "timeout" });
        });
    });
}

interface ModalFieldSpec {
    customId: string;
    label: string;
    /** Pre-filled, editable value shown in the field (usually the current setting). */
    value?: string;
}

/**
 * Shows Back / Fill Form / Skip / Cancel buttons. Fill Form opens a modal with the given
 * numeric fields (pre-filled with their current values where provided) and returns the
 * parsed numbers in field order once submitted. Invalid input replies ephemerally and lets
 * the admin retry without losing the step (the collector stays alive), same for a modal
 * dismissed without submitting.
 */
async function promptNumberModal(
    msg: Message,
    adminId: string,
    title: string,
    description: string,
    fields: ModalFieldSpec[],
    canGoBack: boolean,
): Promise<StepResult<number[]>> {
    await msg.edit({
        embeds: [stepEmbed(title, description)],
        components: [navRow(canGoBack, "Skip", new ButtonBuilder().setCustomId("ez-fill").setLabel("Fill Form").setStyle(ButtonStyle.Primary))],
    });

    let resultValues: number[] | undefined;

    return new Promise((resolve) => {
        const collector = msg.createMessageComponentCollector({
            filter: (i) => i.user.id === adminId,
            componentType: ComponentType.Button,
            time: STEP_TIMEOUT_MS,
        });

        collector.on("collect", async (i) => {
            if (i.customId === "ez-cancel") { await i.deferUpdate(); collector.stop("cancel"); return; }
            if (i.customId === "ez-skip") { await i.deferUpdate(); collector.stop("skip"); return; }
            if (i.customId === "ez-back") { await i.deferUpdate(); collector.stop("back"); return; }
            if (i.customId !== "ez-fill") return;

            const modalId = `ez-modal-${i.id}`;
            const modal = new ModalBuilder().setCustomId(modalId).setTitle(title.slice(0, 45));
            for (const f of fields) {
                const input = new TextInputBuilder().setCustomId(f.customId).setLabel(f.label).setStyle(TextInputStyle.Short).setRequired(true);
                if (f.value !== undefined) input.setValue(f.value);
                modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
            }

            await i.showModal(modal);

            try {
                const submitted = await i.awaitModalSubmit({ filter: (m) => m.customId === modalId && m.user.id === adminId, time: STEP_TIMEOUT_MS });
                const values = fields.map((f) => Number(submitted.fields.getTextInputValue(f.customId)));
                if (values.some((n) => isNaN(n) || n <= 0)) {
                    await submitted.reply({ content: "Please enter valid positive numbers.", ephemeral: true });
                    return;
                }
                await submitted.deferUpdate();
                resultValues = values;
                collector.stop("done");
            } catch {
                // Modal dismissed without submitting (or its own timeout) — collector keeps
                // running, so the buttons on the original message are still usable.
            }
        });

        collector.on("end", (_collected, reason) => {
            if (reason === "done") resolve({ kind: "ok", value: resultValues! });
            else if (reason === "cancel") resolve({ kind: "cancel" });
            else if (reason === "skip") resolve({ kind: "skip" });
            else if (reason === "back") resolve({ kind: "back" });
            else resolve({ kind: "timeout" });
        });
    });
}

/**
 * Lists the configured quota roles (numbered) and waits for the admin to type the
 * number to remove as a plain chat message, racing that against a Back button click.
 */
async function promptRemoveIndex(msg: Message, adminId: string, roles: QuotaRoleRow[]): Promise<number | null> {
    const channel = msg.channel as GuildTextBasedChannel;

    await msg.edit({
        embeds: [stepEmbed(
            "Quota Reward Roles",
            `Type the number of the quota role you want to remove:\n\n${formatNumberedQuotaRoleList(roles)}`,
        )],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(backButton())],
    });

    return new Promise((resolve) => {
        let settled = false;
        const settle = (value: number | null) => {
            if (settled) return;
            settled = true;
            buttonCollector.stop();
            textCollector.stop();
            resolve(value);
        };

        const buttonCollector = msg.createMessageComponentCollector({
            filter: (i) => i.user.id === adminId,
            componentType: ComponentType.Button,
            time: STEP_TIMEOUT_MS,
        });
        const textCollector = channel.createMessageCollector({
            filter: (m) => m.author.id === adminId,
            time: STEP_TIMEOUT_MS,
        });

        buttonCollector.on("collect", async (i) => {
            if (i.customId !== "ez-back") return;
            await i.deferUpdate();
            settle(null);
        });

        textCollector.on("collect", (m) => {
            const n = Number(m.content.trim());
            if (!Number.isInteger(n) || n < 1 || n > roles.length) {
                m.reply(`Please type a number between 1 and ${roles.length}.`).catch(() => {});
                return;
            }
            settle(n);
        });

        buttonCollector.on("end", () => settle(null));
        textCollector.on("end", () => settle(null));
    });
}

// ─── Steps ──────────────────────────────────────────────────────────────────

async function stepCategories(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    const enabledCategories = await getEnabledCategories(guild.id);
    const categoryList = enabledCategories.length > 0
        ? enabledCategories.map((c) => `<#${c.discord_category_id}>`).join(", ")
        : "`no categories selected`";

    await msg.edit({
        embeds: [stepEmbed(
            "Categories",
            "Every time an user runs `bh setup`, I will pick one of the __selected categories__ and create their channel there!\n" +
            "Please select which categories I can use to create __user's macro channels__.\n" +
            "> Note: Click outside the selector to submit.\n\n" +
            ":warning: Discord has a limit of 50 channels per category. If you have a lot of members, please select multiple categories!\n\n" +
            `Currently selected categories:\n${categoryList}`,
        )],
        components: [
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
                new ChannelSelectMenuBuilder().setCustomId("ez-categories").setChannelTypes(ChannelType.GuildCategory)
                    .setMinValues(1).setMaxValues(25).setPlaceholder("Select categories"),
            ),
            navRow(canGoBack, "Skip"),
        ],
    });

    const result = await awaitChannelSelect(msg, adminId);
    if (isTerminal(result)) { await finish(msg, terminalMessage(result.kind)); return result.kind; }
    if (result.kind === "back") return "back";
    if (result.kind === "ok") for (const categoryId of result.value) await addCategoryAction(guild.id, categoryId);
    return "forward";
}

async function stepRoles(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    const roles = await getGuildRoles(guild.id);

    await msg.edit({
        embeds: [stepEmbed(
            "Activity Roles",
            "We categorize users in ACTIVE / IDLE / INACTIVE.\n" +
            "Please select which role should represent each state.\n\n" +
            "Currently, I have these:\n" +
            `${roleLine("Active", roles.active)}\n${roleLine("Idle", roles.idle)}\n${roleLine("Inactive", roles.inactive)}`,
        )],
        components: [
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-role-active").setPlaceholder("Active role")),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-role-idle").setPlaceholder("Idle role")),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-role-inactive").setPlaceholder("Inactive role")),
            navRow(canGoBack, "Skip"),
        ],
    });

    const result = await awaitRoleTriplet(msg, adminId);
    if (isTerminal(result)) { await finish(msg, terminalMessage(result.kind)); return result.kind; }
    if (result.kind === "back") return "back";
    if (result.kind === "ok") await setRolesAction(guild.id, result.value.active, result.value.idle, result.value.inactive);
    return "forward";
}

async function stepThresholds(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    const config = await getOrCreateGuildConfig(guild.id);
    const roles = await getGuildRoles(guild.id);

    const result = await promptNumberModal(
        msg, adminId, "Activity Thresholds",
        "Please tell me the timings I need to use to decide which role an user gets.\n\n" +
        "- Session Gap\n" +
        "> How long a gap between two macro messages can be before we consider it a new session instead of a continuation of the current one. Messages sent within this gap all count toward the same session; once the gap is exceeded, we assume you stopped macroing in between, and the next message starts a brand new session instead (the idle time in between is not counted as active).\n" +
        "> Recommended: don't set this below 22 minutes.\n\n" +
        "- Idle Threshold\n" +
        "> How long since the last valid __macro message__ within the user's macro channel to consider this user as Idle, meaning, they are probably not macroing anymore.\n" +
        `> Example: If the last valid message happened 30 minutes ago, we assume this user stopped macroing for now (and consequently give him the ${roles.idle ? `<@&${roles.idle}>` : "`role_not_set`"} role)\n\n` +
        "- Inactive Threshold\n" +
        "> How long since the last valid __macro message__ within an user's macro channel to consider this user as Inactive, meaning, they are probably not macroing anymore since a long time.\n" +
        `> Example: If the last valid message happened 1 day ago, we assume this user is not macroing anymore (and consequently give them the ${roles.inactive ? `<@&${roles.inactive}>` : "`role_not_set`"} role)\n\n` +
        "Practical example:\n" +
        "- With `session_gap_mins` as `22`, `idle_threshold_mins` as `30` and `inactive_threshold_days` as `1`:\n" +
        "> last valid message within 22 minutes: user becomes active\n" +
        "> last valid message is older than 30 minutes: user becomes idle\n" +
        "> last valid message is older than 1 day: user becomes inactive\n\n" +
        "NOTE: *(in a later stage, you can configure that, if an user is inactive for too long, their channel gets auto-deleted.*",
        [
            { customId: "gap", label: "Session gap (minutes)", value: String(config.session_gap_threshold_s / 60) },
            { customId: "idle", label: "Idle (minutes)", value: String(config.idle_threshold_s / 60) },
            { customId: "inactive", label: "Inactive (hours)", value: String(config.inactive_threshold_s / 3600) },
        ],
        canGoBack,
    );
    if (isTerminal(result)) { await finish(msg, terminalMessage(result.kind)); return result.kind; }
    if (result.kind === "back") return "back";
    if (result.kind === "ok") await activitySetAction(guild.id, result.value[0], result.value[1], result.value[2]);
    return "forward";
}

async function stepAutoDelete(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    while (true) {
        const config = await getOrCreateGuildConfig(guild.id);
        const enabled = await isFlagEnabled(guild.id, "AUTO_DELETE_ENABLED");
        await msg.edit({
            embeds: [stepEmbed(
                "Auto-Delete Inactive Channels (optional)",
                "When enabled, I will automatically delete a user's macro channel once they've been __inactive__ for longer than the inactive threshold, plus this extra grace period. This keeps unused channels from piling up.\n\n" +
                "Current settings:\n" +
                `- Auto-delete: ${enabled ? `\`enabled, ${formatTime(config.delete_inactive_after_s)} after going inactive\`` : `\`disabled (would be ${formatTime(config.delete_inactive_after_s)})\``}`,
            )],
            components: [navRow(
                canGoBack, "Skip",
                new ButtonBuilder().setCustomId("ez-enable").setLabel("Enable").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("ez-disable").setLabel("Disable").setStyle(ButtonStyle.Secondary),
            )],
        });

        const choice = await awaitButton(msg, adminId);
        if (isTerminal(choice)) { await finish(msg, terminalMessage(choice.kind)); return choice.kind; }
        if (choice.kind === "back") return "back";
        if (choice.kind === "skip") return "forward";

        if (choice.kind === "ok" && choice.value === "ez-enable") {
            const hoursResult = await promptNumberModal(
                msg, adminId, "Auto-Delete Inactive Channels",
                "Fill in how many hours after going inactive the channel should be deleted.",
                [{ customId: "hours", label: "Hours after inactive", value: String(config.delete_inactive_after_s / 3600) }],
                true,
            );
            if (isTerminal(hoursResult)) { await finish(msg, terminalMessage(hoursResult.kind)); return hoursResult.kind; }
            if (hoursResult.kind === "back" || hoursResult.kind === "skip") continue;
            await activityDeleteAction(guild.id, hoursResult.value[0]);
            await setGuildFlag(guild.id, "AUTO_DELETE_ENABLED", true);
            return "forward";
        }

        if (choice.kind === "ok" && choice.value === "ez-disable") {
            await setGuildFlag(guild.id, "AUTO_DELETE_ENABLED", false);
            return "forward";
        }
    }
}

async function stepCounter(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    while (true) {
        const config = await getOrCreateGuildConfig(guild.id);
        await msg.edit({
            embeds: [stepEmbed(
                "Live Counter (optional)",
                "I can post a live message showing how many members are active, idle, and inactive right now, and keep it updated automatically every few minutes.\n\n" +
                "Current settings:\n" +
                `- Live counter: ${config.counter_channel_id ? `\`enabled\` in <#${config.counter_channel_id}>` : "`disabled`"}`,
            )],
            components: [navRow(
                canGoBack, "Skip",
                new ButtonBuilder().setCustomId("ez-set").setLabel("Set Channel").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("ez-disable").setLabel("Disable").setStyle(ButtonStyle.Secondary),
            )],
        });

        const choice = await awaitButton(msg, adminId);
        if (isTerminal(choice)) { await finish(msg, terminalMessage(choice.kind)); return choice.kind; }
        if (choice.kind === "back") return "back";
        if (choice.kind === "skip") return "forward";

        if (choice.kind === "ok" && choice.value === "ez-set") {
            await msg.edit({
                embeds: [stepEmbed("Live Counter", "Pick the text channel for the live counter.")],
                components: [
                    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
                        new ChannelSelectMenuBuilder().setCustomId("ez-counter-channel").setChannelTypes(ChannelType.GuildText).setPlaceholder("Select a channel"),
                    ),
                    navRow(true, "Skip"),
                ],
            });
            const channelResult = await awaitChannelSelect(msg, adminId);
            if (isTerminal(channelResult)) { await finish(msg, terminalMessage(channelResult.kind)); return channelResult.kind; }
            if (channelResult.kind === "back" || channelResult.kind === "skip") continue;
            await setCounterChannelAction(guild.id, channelResult.value[0]);
            return "forward";
        }

        if (choice.kind === "ok" && choice.value === "ez-disable") {
            await disableCounterAction(guild.id);
            return "forward";
        }
    }
}

async function stepQuotaRoles(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    while (true) {
        const existingRewards = await getQuotaRolesForGuild(guild.id);
        await msg.edit({
            embeds: [stepEmbed(
                "Quota Reward Roles (optional)",
                "Reward roles are granted automatically to users who meet a __quota__ you set per role, separate from general activity tracking. You can configure as many as you like, each with its own requirement.\n\n" +
                `Currently configured:\n${formatQuotaRoleList(existingRewards)}\n\n` +
                "Add another, or remove one?",
            )],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                backButton().setDisabled(!canGoBack),
                new ButtonBuilder().setCustomId("ez-yes").setLabel("Add").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("ez-remove").setLabel("Remove").setStyle(ButtonStyle.Danger).setDisabled(existingRewards.length === 0),
                skipButton("Skip"),
                cancelButton(),
            )],
        });

        const choice = await awaitButton(msg, adminId);
        if (isTerminal(choice)) { await finish(msg, terminalMessage(choice.kind)); return choice.kind; }
        if (choice.kind === "back") return "back";
        if (choice.kind === "skip") return "forward";

        if (choice.kind === "ok" && choice.value === "ez-remove") {
            const index = await promptRemoveIndex(msg, adminId, existingRewards);
            if (index !== null) await removeQuotaRoleAction(guild.id, existingRewards[index - 1].role_id);
            continue;
        }

        if (choice.kind !== "ok" || choice.value !== "ez-yes") continue;

        // ── Add a new reward role ──
        await msg.edit({
            embeds: [stepEmbed("Quota Reward Roles", "Pick the role to grant.")],
            components: [
                new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-reward-role").setPlaceholder("Reward role")),
                navRow(true, "Skip"),
            ],
        });
        const rewardRole = await new Promise<StepResult<string>>((resolve) => {
            const collector = msg.createMessageComponentCollector({ filter: (i) => i.user.id === adminId, time: STEP_TIMEOUT_MS, max: 1 });
            collector.on("collect", async (i) => {
                await i.deferUpdate();
                if (i.customId === "ez-cancel") { resolve({ kind: "cancel" }); return; }
                if (i.customId === "ez-skip") { resolve({ kind: "skip" }); return; }
                if (i.customId === "ez-back") { resolve({ kind: "back" }); return; }
                if (i.isRoleSelectMenu()) resolve({ kind: "ok", value: i.values[0] });
            });
            collector.on("end", (collected) => { if (collected.size === 0) resolve({ kind: "timeout" }); });
        });
        if (isTerminal(rewardRole)) { await finish(msg, terminalMessage(rewardRole.kind)); return rewardRole.kind; }
        if (rewardRole.kind === "back" || rewardRole.kind === "skip") continue;

        await msg.edit({
            embeds: [stepEmbed(
                "Quota Reward Roles",
                "How should this role be evaluated?\n\n" +
                "- Fixed\n" +
                "> Checked once a day. If the user meets quota, they get the role for a fixed number of days, renewed if they still meet quota before it expires.\n\n" +
                "- Rolling Window\n" +
                "> Checked continuously. The role is granted or removed automatically the moment the user's rolling activity crosses the target, no fixed duration.",
            )],
            components: [navRow(
                true, "Skip",
                new ButtonBuilder().setCustomId("ez-mode-f").setLabel("Fixed").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("ez-mode-rw").setLabel("Rolling Window").setStyle(ButtonStyle.Primary),
            )],
        });
        const modeResult = await awaitButton(msg, adminId);
        if (isTerminal(modeResult)) { await finish(msg, terminalMessage(modeResult.kind)); return modeResult.kind; }
        if (modeResult.kind === "back" || modeResult.kind === "skip") continue;
        const mode: QuotaRoleMode = modeResult.value === "ez-mode-f" ? "F" : "RW";
        const needsDuration = mode === "F";

        const nums = await promptNumberModal(
            msg, adminId, "Quota Reward Roles",
            needsDuration
                ? "Fill in the required hours, the window to check them in, and how many days of access to grant once earned."
                : "Fill in the required hours and the window to check them in. Access is granted or removed automatically as activity crosses this line, no fixed duration needed.",
            needsDuration
                ? [
                    { customId: "hours", label: "Required hours" },
                    { customId: "window", label: "Window (hours)" },
                    { customId: "duration", label: "Access duration (days)" },
                ]
                : [
                    { customId: "hours", label: "Required hours" },
                    { customId: "window", label: "Window (hours)" },
                ],
            true,
        );
        if (isTerminal(nums)) { await finish(msg, terminalMessage(nums.kind)); return nums.kind; }
        if (nums.kind === "back" || nums.kind === "skip") continue;

        await quotasCreateAction(guild.id, rewardRole.value, mode, nums.value[0], nums.value[1], needsDuration ? nums.value[2] : null);
    }
}

async function stepBadgeRoles(guild: Guild, adminId: string, msg: Message, canGoBack: boolean): Promise<Direction> {
    const badgeRoles = await getGuildBadgeRoles(guild.id);
    const badgeRoleMap = new Map(badgeRoles.map((b) => [b.badge, b.role_id]));

    await msg.edit({
        embeds: [stepEmbed(
            "Special Biome Badges (optional)",
            "Some biomes are rare: Glitched, Cyberspace and Dreamspace. The first time a user's macro reports one of them, they permanently earn a badge on their profile.\n\n" +
            "You can optionally also grant a role for each one found. Pick a role for any (or none) of them below.\n\n" +
            "Currently:\n" +
            ALL_BADGES.map((b) => roleLine(`${BADGE_META[b].emoji} ${BADGE_META[b].display}`, badgeRoleMap.get(b) ?? null)).join("\n"),
        )],
        components: [
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-badge-GLITCHED").setPlaceholder(`${BADGE_META.GLITCHED.emoji} Glitched role`)),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-badge-CYBERSPACE").setPlaceholder(`${BADGE_META.CYBERSPACE.emoji} Cyberspace role`)),
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder().setCustomId("ez-badge-DREAMSPACE").setPlaceholder(`${BADGE_META.DREAMSPACE.emoji} Dreamspace role`)),
            navRow(canGoBack, "Skip", new ButtonBuilder().setCustomId("ez-done").setLabel("Done").setStyle(ButtonStyle.Primary)),
        ],
    });

    const result = await awaitBadgeRoleSelects(msg, adminId);
    if (isTerminal(result)) { await finish(msg, terminalMessage(result.kind)); return result.kind; }
    if (result.kind === "back") return "back";
    if (result.kind === "ok") {
        for (const badge of ALL_BADGES) {
            const roleId = result.value[badge];
            if (roleId) await badgesSetAction(guild.id, badge, roleId);
        }
    }
    return "forward";
}

// ─── Driver ─────────────────────────────────────────────────────────────────

export async function runEzSetup(
    guild: Guild,
    adminId: string,
    respond: (payload: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>,
): Promise<void> {
    const msg = await respond({
        embeds: [stepEmbed(
            "Welcome!",
            "This wizard will walk you through every relevant setting, step by step.\n\n" +
            "If this is the first time you're running this wizard, you should answer every question that does not have the `(optional)` header. If you don't answer them, your setup will be unfinished and not work!\n\n" +
            "If this is __NOT__ the first time you're running this wizard, feel free to skip any setting you already configured.",
        )],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ez-yes").setLabel("Start").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("ez-cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger),
        )],
    });

    const start = await awaitButton(msg, adminId);
    if (start.kind !== "ok") return finish(msg, start.kind === "cancel" ? "Setup cancelled." : "Setup timed out.");

    // Ensures the bh_guilds row exists before any step runs - on a brand new guild, this wizard
    // is often the very first command touching this module, and every later step either
    // foreign-keys against bh_guilds (categories, roles) or silently no-ops an UPDATE on it
    // (thresholds, counter) if the row isn't there yet.
    await getOrCreateGuildConfig(guild.id);

    const steps: Array<(canGoBack: boolean) => Promise<Direction>> = [
        (canGoBack) => stepCategories(guild, adminId, msg, canGoBack),
        (canGoBack) => stepRoles(guild, adminId, msg, canGoBack),
        (canGoBack) => stepThresholds(guild, adminId, msg, canGoBack),
        (canGoBack) => stepAutoDelete(guild, adminId, msg, canGoBack),
        (canGoBack) => stepCounter(guild, adminId, msg, canGoBack),
        (canGoBack) => stepQuotaRoles(guild, adminId, msg, canGoBack),
        (canGoBack) => stepBadgeRoles(guild, adminId, msg, canGoBack),
        (canGoBack) => stepBiomeForwards(guild, adminId, msg, canGoBack),
    ];

    let i = 0;
    while (i < steps.length) {
        const direction = await steps[i](i > 0);
        if (direction === "cancel" || direction === "timeout") return; // the step already called finish()
        if (direction === "back") { i = Math.max(0, i - 1); continue; }
        i++;
    }

    const [summary, quotaRoles, readiness] = await Promise.all([
        showConfig(guild.id),
        getQuotaRolesForGuild(guild.id),
        isGuildReady(guild.id),
    ]);

    summary
        .setColor(readiness.ready ? 0x57f287 : 0xed4245)
        .setTitle("bh-ezsetup - Complete")
        .spliceFields(0, 0, {
            name: "Setup Status",
            value: `${readiness.hasCategory ? "✅" : "❌"} At least one enabled category\n${readiness.hasRoles ? "✅" : "❌"} All 3 status roles configured`,
        })
        .addFields({ name: "Quota Reward Roles", value: formatQuotaRoleList(quotaRoles) })
        .setFooter({ text: readiness.ready ? "Setup finished. /bh setup is enabled." : "Setup finished, but something's still missing - check above." });

    await msg.edit({ embeds: [summary], components: [] });
}
