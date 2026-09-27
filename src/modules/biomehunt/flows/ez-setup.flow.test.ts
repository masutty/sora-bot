import { expect, test } from "bun:test";
import { ContainerBuilder } from "discord.js";
import { config } from "@/config";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import type { GuildConfigRow, QuotaRoleRow } from "../types";
import { type EzSetupDeps, ezSetupFlow } from "./ez-setup.flow";

const OWNER = "owner";
const GUILD_ID = "g1";

type Json = {
	custom_id?: string;
	disabled?: boolean;
	content?: string;
	components?: Json[];
	accessory?: Json;
};

/** Every component on the message, as plain JSON, depth-first - same local test glue as the other ported Views. */
function flatten(payload: ViewPayload): Json[] {
	const out: Json[] = [];
	const walk = (node: unknown) => {
		if (node === null || typeof node !== "object") return;
		const json =
			typeof (node as { toJSON?: unknown }).toJSON === "function"
				? (node as { toJSON(): unknown }).toJSON()
				: node;
		if (Array.isArray(json)) {
			for (const child of json) walk(child);
			return;
		}
		const obj = json as Json;
		out.push(obj);
		walk(obj.components);
		walk(obj.accessory);
	};
	walk(payload.components);
	return out;
}

function text(payload: ViewPayload): string {
	return [
		payload.content ?? "",
		...flatten(payload).map((c) => c.content ?? ""),
	]
		.filter(Boolean)
		.join("\n");
}

function comp(payload: ViewPayload, key: string): Json {
	const found = flatten(payload).find((c) => c.custom_id?.endsWith(`:${key}`));
	if (!found) throw new Error(`No component "${key}"`);
	return found;
}

function fakeGuildConfig(
	overrides: Partial<GuildConfigRow> = {},
): GuildConfigRow {
	return {
		guild_id: GUILD_ID,
		session_gap_threshold_s: 1200,
		idle_threshold_s: 1800,
		inactive_threshold_s: 86400,
		auto_create_categories: false,
		delete_inactive_after_s: 86400,
		counter_channel_id: null,
		counter_message_id: null,
		quota_eval_hour_utc: 0,
		quota_last_evaluated_date: null,
		created_at: new Date(),
		updated_at: new Date(),
		...overrides,
	};
}

/** An `EzSetupDeps` that never touches the DB - everything lives in plain in-memory state. */
function fakeDeps(quotaRoles: QuotaRoleRow[] = []) {
	let roles = [...quotaRoles];
	const removeQuotaRoleCalls: Array<{ guildId: string; roleId: string }> = [];
	const deps: EzSetupDeps = {
		getEnabledCategories: async () => [],
		addCategory: async () => "",
		getGuildRoles: async () => ({ active: null, idle: null, inactive: null }),
		setRoles: async () => "",
		getOrCreateGuildConfig: async () => fakeGuildConfig(),
		setActivityThresholds: async () => "",
		isFlagEnabled: async () => false,
		setGuildFlag: async () => {},
		setAutoDeleteThreshold: async () => "",
		setCounterChannel: async () => "",
		disableCounter: async () => "",
		getQuotaRolesForGuild: async () => roles,
		removeQuotaRole: async (guildId, roleId) => {
			removeQuotaRoleCalls.push({ guildId, roleId });
			roles = roles.filter((r) => r.role_id !== roleId);
			return "";
		},
		createQuota: async () => "",
		getGuildBadgeRoles: async () => [],
		setBadges: async () => "",
		showConfig: async () => {
			const container = new ContainerBuilder();
			container.addTextDisplayComponents((td) => td.setContent("placeholder"));
			return container;
		},
		isGuildReady: async () => ({
			ready: false,
			hasCategory: false,
			hasRoles: false,
		}),
		forwards: {
			getForwards: async () => [],
			setForward: async () => {},
			removeForward: async () => {},
		},
	};
	return { deps, removeQuotaRoleCalls };
}

function fakeQuotaRole(overrides: Partial<QuotaRoleRow> = {}): QuotaRoleRow {
	return {
		id: 1,
		guild_id: GUILD_ID,
		role_id: "role1",
		mode: "F",
		quota_target_seconds: 3600,
		quota_window_hours: 24,
		access_duration_days: 7,
		created_at: new Date(),
		updated_at: new Date(),
		...overrides,
	};
}

test("biomehunt.ez-setup: welcome shows first, Start advances to the categories step", async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	void fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	expect(text(fake.lastPayload())).toContain("Welcome!");

	await fake.emit(fake.click("start", OWNER));
	expect(text(fake.lastPayload())).toContain("Categories");
});

test("biomehunt.ez-setup: Back returns to the previous step; Back is disabled on categories (the first real step)", async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	void fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("start", OWNER));
	expect(comp(fake.lastPayload(), "back").disabled).toBe(true);

	await fake.emit(fake.click("skip", OWNER));
	expect(text(fake.lastPayload())).toContain("Activity Roles");
	expect(comp(fake.lastPayload(), "back").disabled).toBe(false);

	await fake.emit(fake.click("back", OWNER));
	expect(text(fake.lastPayload())).toContain("Categories");
});

test('biomehunt.ez-setup: Cancel (from welcome) resolves "cancelled" and shows "Setup cancelled."', async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	const resultP = fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("cancel", OWNER));
	expect(await resultP).toBe("cancelled");
	expect(text(fake.lastPayload())).toContain("Setup cancelled.");
});

test('biomehunt.ez-setup: idling past the timeout shows "Setup timed out." and resolves undefined', async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	const resultP = fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("start", OWNER));
	await fake.clock.advance(config.ui.flowStepTimeoutMs);

	expect(await resultP).toBeUndefined();
	expect(text(fake.lastPayload())).toContain("Setup timed out.");
});

test("biomehunt.ez-setup: thresholds step's Fill Form modal retries on invalid values, then saves and advances", async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	void fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("start", OWNER));
	await fake.emit(fake.click("skip", OWNER)); // categories -> roles
	await fake.emit(fake.click("skip", OWNER)); // roles -> thresholds
	expect(text(fake.lastPayload())).toContain("Activity Thresholds");

	fake.modalResult = async () => ({
		values: { gap: "0", idle: "0", inactive: "0" },
		ack: fake.modalSubmit(OWNER),
	});
	await fake.emit(fake.click("fill", OWNER));
	expect(fake.notifies).toHaveLength(1);
	expect(fake.notifies[0].content).toContain(
		"Please enter valid positive numbers.",
	);
	expect(text(fake.lastPayload())).toContain("Activity Thresholds"); // still on the thresholds screen

	fake.modalResult = async () => ({
		values: { gap: "22", idle: "30", inactive: "24" },
		ack: fake.modalSubmit(OWNER),
	});
	await fake.emit(fake.click("fill", OWNER));
	expect(text(fake.lastPayload())).toContain("Auto-Delete Inactive Channels");
});

test("biomehunt.ez-setup: quota role Remove -> typed number retries on invalid, then removes on a valid one", async () => {
	const existing = [fakeQuotaRole()];
	const { deps, removeQuotaRoleCalls } = fakeDeps(existing);
	const fake = createFakeViewTransport();
	void fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("start", OWNER));
	await fake.emit(fake.click("skip", OWNER)); // categories -> roles
	await fake.emit(fake.click("skip", OWNER)); // roles -> thresholds
	await fake.emit(fake.click("skip", OWNER)); // thresholds -> auto-delete
	await fake.emit(fake.click("skip", OWNER)); // auto-delete -> counter
	await fake.emit(fake.click("skip", OWNER)); // counter -> quota roles
	expect(text(fake.lastPayload())).toContain("Quota Reward Roles");

	await fake.emit(fake.click("remove", OWNER));
	expect(text(fake.lastPayload())).toContain("1. <@&role1>");

	await fake.emit(fake.text(OWNER, "5"));
	expect(fake.notifies).toHaveLength(1);
	expect(fake.notifies[0].content).toContain(
		"Please type a number between 1 and 1.",
	);
	expect(removeQuotaRoleCalls).toHaveLength(0);

	await fake.emit(fake.text(OWNER, "1"));
	expect(removeQuotaRoleCalls).toEqual([
		{ guildId: GUILD_ID, roleId: "role1" },
	]);
	expect(text(fake.lastPayload())).toContain("None configured yet.");
});

test("biomehunt.ez-setup: Skip on the forwards step (the last one) finishes with the summary screen", async () => {
	const { deps } = fakeDeps();
	const fake = createFakeViewTransport();
	const resultP = fake.run(ezSetupFlow(deps, GUILD_ID), undefined, OWNER);
	await fake.flush();

	await fake.emit(fake.click("start", OWNER));
	for (let i = 0; i < 7; i++) {
		await fake.emit(fake.click("skip", OWNER));
	}
	expect(text(fake.lastPayload())).toContain("Biome Forwards"); // now on the forwards step

	await fake.emit(fake.click("skip", OWNER));
	expect(await resultP).toBe("finished");
	expect(text(fake.lastPayload())).toContain("bh-admin setup: Complete");
	expect(text(fake.lastPayload())).toContain("Setup finished");
});
