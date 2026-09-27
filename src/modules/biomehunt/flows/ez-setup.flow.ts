import {
	ButtonStyle,
	ChannelType,
	ContainerBuilder,
	MessageFlags,
	SeparatorSpacingSize,
	TextDisplayBuilder,
} from "discord.js";
import {
	type CommandContext,
	defineView,
	type FlowStep,
	flow,
	type HandlerContext,
	navHandlers,
	navRow,
	type StepResult,
	type ViewDefinition,
	type ViewPayload,
} from "@/define";
import { EmbedFormatter, formatTime, NO_PINGS } from "@/utils/format";
import { ALL_BADGES, BADGE_META } from "../constants/badges.constants";
import { getGuildBadgeRoles } from "../repository/badges.repository";
import { isFlagEnabled, setGuildFlag } from "../repository/flags.repository";
import {
	getForwardConfigs,
	removeForwardConfig,
	setForwardConfig,
} from "../repository/forwards.repository";
import {
	getEnabledCategories,
	getGuildRoles,
	getOrCreateGuildConfig,
	isGuildReady,
} from "../repository/guilds.repository";
import { getQuotaRolesForGuild } from "../repository/quota-roles.repository";
import {
	setActivityThresholds,
	setAutoDeleteThreshold,
} from "../services/activity.service";
import { setBadges } from "../services/badge.service";
import {
	addCategory,
	disableCounter,
	setCounterChannel,
	setRoles,
	showConfig,
} from "../services/guild-config.service";
import { createQuota, removeQuotaRole } from "../services/quota.service";
import type { Badge, QuotaRoleMode, QuotaRoleRow } from "../types";
import {
	type ForwardListDeps,
	forwardListView,
} from "../views/forward-list.view";

/**
 * Everything the wizard needs that would otherwise be a DB call, injected so its tests never hit
 * it - `defaultEzSetupDeps` wires the real repository/service functions (see `runEzSetupFlow`).
 */
export interface EzSetupDeps {
	getEnabledCategories: typeof getEnabledCategories;
	addCategory: typeof addCategory;
	getGuildRoles: typeof getGuildRoles;
	setRoles: typeof setRoles;
	getOrCreateGuildConfig: typeof getOrCreateGuildConfig;
	setActivityThresholds: typeof setActivityThresholds;
	isFlagEnabled: typeof isFlagEnabled;
	setGuildFlag: typeof setGuildFlag;
	setAutoDeleteThreshold: typeof setAutoDeleteThreshold;
	setCounterChannel: typeof setCounterChannel;
	disableCounter: typeof disableCounter;
	getQuotaRolesForGuild: typeof getQuotaRolesForGuild;
	removeQuotaRole: typeof removeQuotaRole;
	createQuota: typeof createQuota;
	getGuildBadgeRoles: typeof getGuildBadgeRoles;
	setBadges: typeof setBadges;
	showConfig: typeof showConfig;
	isGuildReady: typeof isGuildReady;
	/** Wired to `forwardListView` - the wizard's last step. */
	forwards: ForwardListDeps;
}

/** The real repository/service wiring - the only real DB calls this module makes. */
export function defaultEzSetupDeps(): EzSetupDeps {
	return {
		getEnabledCategories,
		addCategory,
		getGuildRoles,
		setRoles,
		getOrCreateGuildConfig,
		setActivityThresholds,
		isFlagEnabled,
		setGuildFlag,
		setAutoDeleteThreshold,
		setCounterChannel,
		disableCounter,
		getQuotaRolesForGuild,
		removeQuotaRole,
		createQuota,
		getGuildBadgeRoles,
		setBadges,
		showConfig,
		isGuildReady,
		forwards: {
			getForwards: getForwardConfigs,
			setForward: setForwardConfig,
			removeForward: async (guildId, biome) => {
				await removeForwardConfig(guildId, biome);
			},
		},
	};
}

/** Handed to every step (and to `onFinish`) as its `input` - see `flow`'s `FlowOptions.context`. */
export interface EzSetupContext {
	guildId: string;
	/** Always true - the forwards step (`views/forward-list.view.ts`, in "step" mode) is never the wizard's first step. */
	canGoBack: boolean;
}

// ─── Shared rendering helpers (unchanged from the pre-View version) ────────────────────────────

function stepContainer(title: string, description: string): ContainerBuilder {
	const container = new ContainerBuilder().setAccentColor(0x5865f2);
	container.addTextDisplayComponents((td) =>
		td.setContent(`## bh-admin setup: ${title}`),
	);
	container.addSeparatorComponents((sep) =>
		sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
	);
	container.addTextDisplayComponents((td) => td.setContent(description));
	return container;
}

function stepPayload(
	components: NonNullable<ViewPayload["components"]>,
): ViewPayload {
	return {
		flags: MessageFlags.IsComponentsV2,
		components,
		allowedMentions: NO_PINGS,
	};
}

function formatQuotaRoleLine(qr: QuotaRoleRow): string {
	const modeLabel = qr.mode === "F" ? "Fixed" : "RW";
	const hours = qr.quota_target_seconds / 3600;
	const durationNote =
		qr.mode === "F" ? `, ${qr.access_duration_days}d access` : "";
	return `<@&${qr.role_id}> - ${modeLabel} ${hours}h/${qr.quota_window_hours}h${durationNote}`;
}

/** Plain summary of currently configured quota roles (no numbering — used on the gate screen). */
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

// ─── Welcome (step 0) ───────────────────────────────────────────────────────────────────────────

interface WelcomeState {
	guildId: string;
}

function welcomeStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<WelcomeState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.welcome",
		initial: (ctx) => ({ guildId: ctx.guildId }),
		render: (_state, kit) =>
			stepPayload([
				stepContainer(
					"Welcome!",
					"This wizard will walk you through every relevant setting, step by step.\n\n" +
						"If this is the first time you're running this wizard, you should answer every question that does not have the `(optional)` header. If you don't answer them, your setup will be unfinished and not work!\n\n" +
						"If this is __NOT__ the first time you're running this wizard, feel free to skip any setting you already configured.",
				),
				kit.row(
					kit.button("start", (b) =>
						b.setLabel("Start").setStyle(ButtonStyle.Success),
					),
					kit.button("cancel", (b) =>
						b.setLabel("Cancel").setStyle(ButtonStyle.Danger),
					),
				),
			]),
		on: {
			start: async (c) => {
				// Ensures the bh_guilds row exists before any step runs - on a brand new guild, this
				// wizard is often the very first command touching this module, and every later step
				// either foreign-keys against bh_guilds (categories, roles) or silently no-ops an
				// UPDATE on it (thresholds, counter) if the row isn't there yet.
				await deps.getOrCreateGuildConfig(c.state.guildId);
				c.done({ kind: "ok" });
			},
			cancel: (c) => c.done({ kind: "cancel" }),
		},
	});
}

// ─── Categories ─────────────────────────────────────────────────────────────────────────────────

interface CategoriesState {
	guildId: string;
	categoryList: string;
}

function categoriesStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<CategoriesState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.categories",
		initial: async (ctx) => {
			const enabled = await deps.getEnabledCategories(ctx.guildId);
			const categoryList =
				enabled.length > 0
					? enabled.map((c) => `<#${c.discord_category_id}>`).join(", ")
					: "`no categories selected`";
			return { guildId: ctx.guildId, categoryList };
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Categories",
					"Every time an user runs `bh setup`, I will pick one of the __selected categories__ and create their channel there!\n" +
						"Please select which categories I can use to create __user's macro channels__.\n" +
						"> Note: Click outside the selector to submit.\n\n" +
						":warning: Discord has a limit of 50 channels per category. If you have a lot of members, please select multiple categories!\n\n" +
						`Currently selected categories:\n${state.categoryList}`,
				),
				kit.row(
					kit.channelSelect("categories", (s) =>
						s
							.setChannelTypes(ChannelType.GuildCategory)
							.setMinValues(1)
							.setMaxValues(25)
							.setPlaceholder("Select categories"),
					),
				),
				navRow(kit, { canBack: false }),
			]),
		on: {
			categories: async (c) => {
				for (const categoryId of c.values)
					await deps.addCategory(c.state.guildId, categoryId);
				c.done({ kind: "ok" });
			},
			...navHandlers<CategoriesState>(),
		},
	});
}

// ─── Activity roles ─────────────────────────────────────────────────────────────────────────────

interface RolesState {
	guildId: string;
	currentActive: string | null;
	currentIdle: string | null;
	currentInactive: string | null;
	active?: string;
	idle?: string;
	inactive?: string;
}

async function maybeSaveRoles(
	c: HandlerContext<RolesState, StepResult>,
	deps: EzSetupDeps,
): Promise<void> {
	const { active, idle, inactive, guildId } = c.state;
	if (!active || !idle || !inactive) return;
	await deps.setRoles(guildId, active, idle, inactive);
	c.done({ kind: "ok" });
}

function rolesStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<RolesState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.roles",
		initial: async (ctx) => {
			const roles = await deps.getGuildRoles(ctx.guildId);
			return {
				guildId: ctx.guildId,
				currentActive: roles.active,
				currentIdle: roles.idle,
				currentInactive: roles.inactive,
			};
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Activity Roles",
					"We categorize users in ACTIVE / IDLE / INACTIVE.\n" +
						"Please select which role should represent each state.\n\n" +
						"Currently, I have these:\n" +
						`${roleLine("Active", state.currentActive)}\n${roleLine("Idle", state.currentIdle)}\n${roleLine("Inactive", state.currentInactive)}`,
				),
				kit.row(
					kit.roleSelect("active", (s) => s.setPlaceholder("Active role")),
				),
				kit.row(kit.roleSelect("idle", (s) => s.setPlaceholder("Idle role"))),
				kit.row(
					kit.roleSelect("inactive", (s) => s.setPlaceholder("Inactive role")),
				),
				navRow(kit, { canBack: true }),
			]),
		on: {
			active: (c) => {
				c.state.active = c.values[0];
				return maybeSaveRoles(c, deps);
			},
			idle: (c) => {
				c.state.idle = c.values[0];
				return maybeSaveRoles(c, deps);
			},
			inactive: (c) => {
				c.state.inactive = c.values[0];
				return maybeSaveRoles(c, deps);
			},
			...navHandlers<RolesState>(),
		},
	});
}

// ─── Activity thresholds ────────────────────────────────────────────────────────────────────────

interface ThresholdsState {
	guildId: string;
	gapMinutes: string;
	idleMinutes: string;
	inactiveHours: string;
	idleRoleId: string | null;
	inactiveRoleId: string | null;
}

function thresholdsStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<ThresholdsState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.thresholds",
		initial: async (ctx) => {
			const config = await deps.getOrCreateGuildConfig(ctx.guildId);
			const roles = await deps.getGuildRoles(ctx.guildId);
			return {
				guildId: ctx.guildId,
				gapMinutes: String(config.session_gap_threshold_s / 60),
				idleMinutes: String(config.idle_threshold_s / 60),
				inactiveHours: String(config.inactive_threshold_s / 3600),
				idleRoleId: roles.idle,
				inactiveRoleId: roles.inactive,
			};
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Activity Thresholds",
					"Please tell me the timings I need to use to decide which role an user gets.\n\n" +
						"- Session Gap\n" +
						"> How long a gap between two macro messages can be before we consider it a new session instead of a continuation of the current one. Messages sent within this gap all count toward the same session; once the gap is exceeded, we assume you stopped macroing in between, and the next message starts a brand new session instead (the idle time in between is not counted as active).\n" +
						"> Recommended: don't set this below 22 minutes.\n\n" +
						"- Idle Threshold\n" +
						"> How long since the last valid __macro message__ within the user's macro channel to consider this user as Idle, meaning, they are probably not macroing anymore.\n" +
						`> Example: If the last valid message happened 30 minutes ago, we assume this user stopped macroing for now (and consequently give him the ${state.idleRoleId ? `<@&${state.idleRoleId}>` : "`role_not_set`"} role)\n\n` +
						"- Inactive Threshold\n" +
						"> How long since the last valid __macro message__ within an user's macro channel to consider this user as Inactive, meaning, they are probably not macroing anymore since a long time.\n" +
						`> Example: If the last valid message happened 1 day ago, we assume this user is not macroing anymore (and consequently give them the ${state.inactiveRoleId ? `<@&${state.inactiveRoleId}>` : "`role_not_set`"} role)\n\n` +
						"Practical example:\n" +
						"- With `session_gap_mins` as `22`, `idle_threshold_mins` as `30` and `inactive_threshold_days` as `1`:\n" +
						"> last valid message within 22 minutes: user becomes active\n" +
						"> last valid message is older than 30 minutes: user becomes idle\n" +
						"> last valid message is older than 1 day: user becomes inactive\n\n" +
						"NOTE: *(in a later stage, you can configure that, if an user is inactive for too long, their channel gets auto-deleted.*",
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("fill", (b) =>
							b.setLabel("Fill Form").setStyle(ButtonStyle.Primary),
						),
					],
				}),
			]),
		on: {
			fill: async (c) => {
				const v = await c.modal({
					title: "Activity Thresholds",
					fields: [
						{
							key: "gap",
							label: "Session gap (minutes)",
							value: c.state.gapMinutes,
						},
						{
							key: "idle",
							label: "Idle (minutes)",
							value: c.state.idleMinutes,
						},
						{
							key: "inactive",
							label: "Inactive (hours)",
							value: c.state.inactiveHours,
						},
					],
				});
				if (!v) return;
				const gap = Number(v.gap);
				const idle = Number(v.idle);
				const inactive = Number(v.inactive);
				if ([gap, idle, inactive].some((n) => Number.isNaN(n) || n <= 0)) {
					await c.notify("Please enter valid positive numbers.");
					return;
				}
				await deps.setActivityThresholds(c.state.guildId, gap, idle, inactive);
				c.done({ kind: "ok" });
			},
			...navHandlers<ThresholdsState>(),
		},
	});
}

// ─── Auto-delete (optional) ─────────────────────────────────────────────────────────────────────

interface AutoDeleteState {
	guildId: string;
	enabled: boolean;
	hoursDisplay: string;
}

function autoDeleteStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<AutoDeleteState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.auto-delete",
		initial: async (ctx) => {
			const config = await deps.getOrCreateGuildConfig(ctx.guildId);
			const enabled = await deps.isFlagEnabled(
				ctx.guildId,
				"AUTO_DELETE_ENABLED",
			);
			return {
				guildId: ctx.guildId,
				enabled,
				hoursDisplay: formatTime(config.delete_inactive_after_s),
			};
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Auto-Delete Inactive Channels (optional)",
					"When enabled, I will automatically delete a user's macro channel once they've been __inactive__ for longer than the inactive threshold, plus this extra grace period. This keeps unused channels from piling up.\n\n" +
						"Current settings:\n" +
						`- Auto-delete: ${state.enabled ? `\`enabled, ${state.hoursDisplay} after going inactive\`` : `\`disabled (would be ${state.hoursDisplay})\``}`,
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("enable", (b) =>
							b.setLabel("Enable").setStyle(ButtonStyle.Primary),
						),
						kit.button("disable", (b) =>
							b.setLabel("Disable").setStyle(ButtonStyle.Secondary),
						),
					],
				}),
			]),
		on: {
			enable: async (c) => {
				const result = await c.open(autoDeleteHoursView(deps), {
					guildId: c.state.guildId,
				});
				if (!result) return;
				if (result.kind === "cancel") {
					c.done({ kind: "cancel" });
					return;
				}
				if (result.kind === "ok") c.done({ kind: "ok" });
				// back/skip: nothing changed - stay on this main screen.
			},
			disable: async (c) => {
				await deps.setGuildFlag(c.state.guildId, "AUTO_DELETE_ENABLED", false);
				c.done({ kind: "ok" });
			},
			...navHandlers<AutoDeleteState>(),
		},
	});
}

interface AutoDeleteHoursInput {
	guildId: string;
}

interface AutoDeleteHoursState {
	guildId: string;
	currentHours: string;
}

function autoDeleteHoursView(
	deps: EzSetupDeps,
): ViewDefinition<AutoDeleteHoursState, StepResult, AutoDeleteHoursInput> {
	return defineView<AutoDeleteHoursState, StepResult, AutoDeleteHoursInput>({
		name: "biomehunt.ez-setup.auto-delete-hours",
		initial: async (input) => {
			const config = await deps.getOrCreateGuildConfig(input.guildId);
			return {
				guildId: input.guildId,
				currentHours: String(config.delete_inactive_after_s / 3600),
			};
		},
		render: (_state, kit) =>
			stepPayload([
				stepContainer(
					"Auto-Delete Inactive Channels",
					"Fill in how many hours after going inactive the channel should be deleted.",
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("fill", (b) =>
							b.setLabel("Fill Form").setStyle(ButtonStyle.Primary),
						),
					],
				}),
			]),
		on: {
			fill: async (c) => {
				const v = await c.modal({
					title: "Auto-Delete Inactive Channels",
					fields: [
						{
							key: "hours",
							label: "Hours after inactive",
							value: c.state.currentHours,
						},
					],
				});
				if (!v) return;
				const hours = Number(v.hours);
				if (Number.isNaN(hours) || hours <= 0) {
					await c.notify("Please enter valid positive numbers.");
					return;
				}
				await deps.setAutoDeleteThreshold(c.state.guildId, hours);
				await deps.setGuildFlag(c.state.guildId, "AUTO_DELETE_ENABLED", true);
				c.done({ kind: "ok" });
			},
			...navHandlers<AutoDeleteHoursState>(),
		},
	});
}

// ─── Live counter (optional) ────────────────────────────────────────────────────────────────────

interface CounterState {
	guildId: string;
	channelId: string | null;
}

function counterStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<CounterState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.counter",
		initial: async (ctx) => {
			const config = await deps.getOrCreateGuildConfig(ctx.guildId);
			return { guildId: ctx.guildId, channelId: config.counter_channel_id };
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Live Counter (optional)",
					"I can post a live message showing how many members are active, idle, and inactive right now, and keep it updated automatically every few minutes.\n\n" +
						"Current settings:\n" +
						`- Live counter: ${state.channelId ? `\`enabled\` in <#${state.channelId}>` : "`disabled`"}`,
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("set", (b) =>
							b.setLabel("Set Channel").setStyle(ButtonStyle.Primary),
						),
						kit.button("disable", (b) =>
							b.setLabel("Disable").setStyle(ButtonStyle.Secondary),
						),
					],
				}),
			]),
		on: {
			set: async (c) => {
				const result = await c.open(counterChannelView(deps), {
					guildId: c.state.guildId,
				});
				if (!result) return;
				if (result.kind === "cancel") {
					c.done({ kind: "cancel" });
					return;
				}
				if (result.kind === "ok") c.done({ kind: "ok" });
			},
			disable: async (c) => {
				await deps.disableCounter(c.state.guildId);
				c.done({ kind: "ok" });
			},
			...navHandlers<CounterState>(),
		},
	});
}

interface CounterChannelInput {
	guildId: string;
}

interface CounterChannelState {
	guildId: string;
}

function counterChannelView(
	deps: EzSetupDeps,
): ViewDefinition<CounterChannelState, StepResult, CounterChannelInput> {
	return defineView<CounterChannelState, StepResult, CounterChannelInput>({
		name: "biomehunt.ez-setup.counter-channel",
		initial: (input) => ({ guildId: input.guildId }),
		render: (_state, kit) =>
			stepPayload([
				stepContainer(
					"Live Counter",
					"Pick the text channel for the live counter.",
				),
				kit.row(
					kit.channelSelect("channel", (s) =>
						s
							.setChannelTypes(ChannelType.GuildText)
							.setPlaceholder("Select a channel"),
					),
				),
				navRow(kit, { canBack: true }),
			]),
		on: {
			channel: async (c) => {
				await deps.setCounterChannel(c.state.guildId, c.values[0]);
				c.done({ kind: "ok" });
			},
			...navHandlers<CounterChannelState>(),
		},
	});
}

// ─── Quota reward roles (optional) ──────────────────────────────────────────────────────────────

interface QuotaRolesState {
	guildId: string;
	existingRewards: QuotaRoleRow[];
}

function quotaRolesStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<QuotaRolesState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.quota-roles",
		initial: async (ctx) => ({
			guildId: ctx.guildId,
			existingRewards: await deps.getQuotaRolesForGuild(ctx.guildId),
		}),
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Quota Reward Roles (optional)",
					"Reward roles are granted automatically to users who meet a __quota__ you set per role, separate from general activity tracking. You can configure as many as you like, each with its own requirement.\n\n" +
						`Currently configured:\n${formatQuotaRoleList(state.existingRewards)}\n\n` +
						"Add another, or remove one?",
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("add", (b) =>
							b.setLabel("Add").setStyle(ButtonStyle.Success),
						),
						kit.button("remove", (b) =>
							b
								.setLabel("Remove")
								.setStyle(ButtonStyle.Danger)
								.setDisabled(state.existingRewards.length === 0),
						),
					],
				}),
			]),
		on: {
			add: async (c) => {
				const result = await c.open(quotaRoleAddView(deps), {
					guildId: c.state.guildId,
				});
				if (!result) return;
				if (result.kind === "cancel") {
					c.done({ kind: "cancel" });
					return;
				}
				c.state.existingRewards = await deps.getQuotaRolesForGuild(
					c.state.guildId,
				);
				// ok/back/skip all just refresh the gate screen - adding never advances the step on its own.
			},
			remove: async (c) => {
				const picked = await c.open(quotaRoleRemoveView(), {
					roles: c.state.existingRewards,
				});
				if (picked) {
					await deps.removeQuotaRole(c.state.guildId, picked.role_id);
					c.state.existingRewards = await deps.getQuotaRolesForGuild(
						c.state.guildId,
					);
				}
			},
			...navHandlers<QuotaRolesState>(),
		},
	});
}

interface QuotaAddInput {
	guildId: string;
}

interface QuotaAddState {
	guildId: string;
	phase: "role" | "mode" | "amount";
	roleId?: string;
	mode?: QuotaRoleMode;
}

function quotaRoleAddView(
	deps: EzSetupDeps,
): ViewDefinition<QuotaAddState, StepResult, QuotaAddInput> {
	return defineView<QuotaAddState, StepResult, QuotaAddInput>({
		name: "biomehunt.ez-setup.quota-role-add",
		initial: (input) => ({ guildId: input.guildId, phase: "role" }),
		render: (state, kit) => {
			if (state.phase === "role") {
				return stepPayload([
					stepContainer("Quota Reward Roles", "Pick the role to grant."),
					kit.row(
						kit.roleSelect("role", (s) => s.setPlaceholder("Reward role")),
					),
					navRow(kit, { canBack: true }),
				]);
			}
			if (state.phase === "mode") {
				return stepPayload([
					stepContainer(
						"Quota Reward Roles",
						"How should this role be evaluated?\n\n" +
							"- Fixed\n" +
							"> Checked once a day. If the user meets quota, they get the role for a fixed number of days, renewed if they still meet quota before it expires.\n\n" +
							"- Rolling Window\n" +
							"> Checked continuously. The role is granted or removed automatically the moment the user's rolling activity crosses the target, no fixed duration.",
					),
					navRow(kit, {
						canBack: true,
						extra: [
							kit.button("modeF", (b) =>
								b.setLabel("Fixed").setStyle(ButtonStyle.Primary),
							),
							kit.button("modeRW", (b) =>
								b.setLabel("Rolling Window").setStyle(ButtonStyle.Primary),
							),
						],
					}),
				]);
			}
			const needsDuration = state.mode === "F";
			return stepPayload([
				stepContainer(
					"Quota Reward Roles",
					needsDuration
						? "Fill in the required hours, the window to check them in, and how many days of access to grant once earned."
						: "Fill in the required hours and the window to check them in. Access is granted or removed automatically as activity crosses this line, no fixed duration needed.",
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("fill", (b) =>
							b.setLabel("Fill Form").setStyle(ButtonStyle.Primary),
						),
					],
				}),
			]);
		},
		on: {
			role: (c) => {
				c.state.roleId = c.values[0];
				c.state.phase = "mode";
			},
			modeF: (c) => {
				c.state.mode = "F";
				c.state.phase = "amount";
			},
			modeRW: (c) => {
				c.state.mode = "RW";
				c.state.phase = "amount";
			},
			fill: async (c) => {
				const needsDuration = c.state.mode === "F";
				const v = await c.modal({
					title: "Quota Reward Roles",
					fields: needsDuration
						? [
								{ key: "hours", label: "Required hours" },
								{ key: "window", label: "Window (hours)" },
								{ key: "duration", label: "Access duration (days)" },
							]
						: [
								{ key: "hours", label: "Required hours" },
								{ key: "window", label: "Window (hours)" },
							],
				});
				if (!v) return;
				const hours = Number(v.hours);
				const windowHours = Number(v.window);
				const duration = needsDuration ? Number(v.duration) : null;
				const numbers = needsDuration
					? [hours, windowHours, duration as number]
					: [hours, windowHours];
				if (numbers.some((n) => Number.isNaN(n) || n <= 0)) {
					await c.notify("Please enter valid positive numbers.");
					return;
				}
				await deps.createQuota(
					c.state.guildId,
					c.state.roleId as string,
					c.state.mode as QuotaRoleMode,
					hours,
					windowHours,
					duration,
				);
				c.done({ kind: "ok" });
			},
			...navHandlers<QuotaAddState>(),
		},
	});
}

interface QuotaRemoveInput {
	roles: QuotaRoleRow[];
}

interface QuotaRemoveState {
	roles: QuotaRoleRow[];
}

function quotaRoleRemoveView(): ViewDefinition<
	QuotaRemoveState,
	QuotaRoleRow | undefined,
	QuotaRemoveInput
> {
	return defineView<
		QuotaRemoveState,
		QuotaRoleRow | undefined,
		QuotaRemoveInput
	>({
		name: "biomehunt.ez-setup.quota-role-remove",
		initial: (input) => ({ roles: input.roles }),
		render: (state, kit) => ({
			...stepPayload([
				stepContainer(
					"Quota Reward Roles",
					`Type the number of the quota role you want to remove:\n\n${formatNumberedQuotaRoleList(state.roles)}`,
				),
				kit.row(kit.button("back", (b) => b.setLabel("Back"))),
			]),
			acceptText: true,
		}),
		on: { back: (c) => c.done(undefined) },
		onText: async (c) => {
			const n = Number(c.text.trim());
			if (!Number.isInteger(n) || n < 1 || n > c.state.roles.length) {
				await c.notify(
					`Please type a number between 1 and ${c.state.roles.length}.`,
				);
				return;
			}
			c.done(c.state.roles[n - 1]);
		},
	});
}

// ─── Special biome badges (optional) ────────────────────────────────────────────────────────────

interface BadgeRolesState {
	guildId: string;
	current: Partial<Record<Badge, string>>;
	picked: Partial<Record<Badge, string>>;
}

function badgeRolesStep(deps: EzSetupDeps): FlowStep<EzSetupContext> {
	return defineView<BadgeRolesState, StepResult, EzSetupContext>({
		name: "biomehunt.ez-setup.badge-roles",
		initial: async (ctx) => {
			const badgeRoles = await deps.getGuildBadgeRoles(ctx.guildId);
			const current: Partial<Record<Badge, string>> = {};
			for (const b of badgeRoles) current[b.badge] = b.role_id;
			return { guildId: ctx.guildId, current, picked: {} };
		},
		render: (state, kit) =>
			stepPayload([
				stepContainer(
					"Special Biome Badges (optional)",
					"Some biomes are rare: Glitched, Cyberspace and Dreamspace. The first time a user's macro reports one of them, they permanently earn a badge on their profile.\n\n" +
						"You can optionally also grant a role for each one found. Pick a role for any (or none) of them below.\n\n" +
						"Currently:\n" +
						ALL_BADGES.map((b) =>
							roleLine(
								`${BADGE_META[b].emoji} ${BADGE_META[b].display}`,
								state.current[b] ?? null,
							),
						).join("\n"),
				),
				kit.row(
					kit.roleSelect("GLITCHED", (s) =>
						s.setPlaceholder(`${BADGE_META.GLITCHED.emoji} Glitched role`),
					),
				),
				kit.row(
					kit.roleSelect("CYBERSPACE", (s) =>
						s.setPlaceholder(`${BADGE_META.CYBERSPACE.emoji} Cyberspace role`),
					),
				),
				kit.row(
					kit.roleSelect("DREAMSPACE", (s) =>
						s.setPlaceholder(`${BADGE_META.DREAMSPACE.emoji} Dreamspace role`),
					),
				),
				navRow(kit, {
					canBack: true,
					extra: [
						kit.button("done", (b) =>
							b.setLabel("Done").setStyle(ButtonStyle.Primary),
						),
					],
				}),
			]),
		on: {
			GLITCHED: (c) => {
				c.state.picked.GLITCHED = c.values[0];
			},
			CYBERSPACE: (c) => {
				c.state.picked.CYBERSPACE = c.values[0];
			},
			DREAMSPACE: (c) => {
				c.state.picked.DREAMSPACE = c.values[0];
			},
			done: async (c) => {
				for (const badge of ALL_BADGES) {
					const roleId = c.state.picked[badge];
					if (roleId) await deps.setBadges(c.state.guildId, badge, roleId);
				}
				c.done({ kind: "ok" });
			},
			...navHandlers<BadgeRolesState>(),
		},
	});
}

// ─── Final summary ──────────────────────────────────────────────────────────────────────────────

async function buildSummary(
	ctx: EzSetupContext,
	deps: EzSetupDeps,
): Promise<ViewPayload> {
	const [summary, quotaRoles, readiness] = await Promise.all([
		deps.showConfig(ctx.guildId),
		deps.getQuotaRolesForGuild(ctx.guildId),
		deps.isGuildReady(ctx.guildId),
	]);

	summary
		.setAccentColor(readiness.ready ? 0x57f287 : 0xed4245)
		.spliceComponents(
			0,
			1,
			new TextDisplayBuilder().setContent("## bh-admin setup: Complete"),
		)
		.spliceComponents(
			1,
			0,
			new TextDisplayBuilder().setContent(
				`**Setup Status**\n${readiness.hasCategory ? "✅" : "❌"} At least one enabled category\n${readiness.hasRoles ? "✅" : "❌"} All 3 status roles configured`,
			),
		)
		.addSeparatorComponents((sep) =>
			sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
		)
		.addTextDisplayComponents((td) =>
			td.setContent(
				`**Quota Reward Roles**\n${formatQuotaRoleList(quotaRoles)}`,
			),
		)
		.addSeparatorComponents((sep) =>
			sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
		)
		.addTextDisplayComponents((td) =>
			td.setContent(
				`-# ${readiness.ready ? "Setup finished. /bh setup is enabled." : "Setup finished, but something's still missing - check above."}`,
			),
		);

	return stepPayload([summary]);
}

// ─── Driver ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `bh-admin setup`'s guided wizard - welcome, categories, activity roles, thresholds, auto-delete,
 * live counter, quota reward roles, badge roles, then biome forwards (`forwardListView`, shared
 * with the standalone `bh-admin forward menu`), ending in a `showConfig`/`isGuildReady` summary.
 */
export function ezSetupFlow(
	deps: EzSetupDeps,
	guildId: string,
): ViewDefinition<
	{ index: number; final?: ViewPayload },
	"finished" | "cancelled",
	void
> {
	const context: EzSetupContext = { guildId, canGoBack: true };
	return flow<EzSetupContext>({
		name: "biomehunt.ez-setup",
		context,
		steps: [
			welcomeStep(deps),
			categoriesStep(deps),
			rolesStep(deps),
			thresholdsStep(deps),
			autoDeleteStep(deps),
			counterStep(deps),
			quotaRolesStep(deps),
			badgeRolesStep(deps),
			forwardListView(deps.forwards, "step"),
		],
		onFinish: (ctx) => buildSummary(ctx, deps),
		onCancel: EmbedFormatter.info("Setup cancelled."),
		onTimeout: EmbedFormatter.info("Setup timed out."),
	});
}

export async function runEzSetupFlow(
	ctx: CommandContext,
	guildId: string,
): Promise<void> {
	await ctx.open(ezSetupFlow(defaultEzSetupDeps(), guildId), undefined);
}
