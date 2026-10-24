import type { GuildMember } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { defineWorker } from "@/define";
import { Logger } from "@/utils/logging";
import { settings } from "../settings";

const logger = new Logger("biomehunt.workers.shop-roles");

/** Grants handled per tick, and how many due rows are read to find them (failing ones are skipped, not dropped). */
const HANDLED_PER_TICK = 50;
const DUE_READ = 200;
/** A grant whose removal failed is left alone this long. */
const RETRY_AFTER_MS = 10 * 60_000;

/** Unknown Guild, Unknown Member, Unknown Role, Unknown User - the role can't be on the member any more. */
const GONE_CODES = new Set([10004, 10007, 10011, 10013]);

type DueGrant = { guildId: string; discordUserId: string; roleId: string };

/** What a tick needs from the database and Discord, injected so tests use neither. */
export interface ShopRolesDeps {
    now(): Date;
    getDueGrants(now: Date, limit: number): Promise<DueGrant[]>;
    getActiveGrantEnd(guildId: string, discordUserId: string, roleId: string, now: Date): Promise<Date | null>;
    /** Deletes the grant only if it is still over; false when a renewal beat it or a refund already deleted it. */
    deleteGrant(guildId: string, discordUserId: string, roleId: string, now: Date): Promise<boolean>;
    /** "gone" means the member or the role no longer exists, so there is nothing to remove. */
    removeRole(guildId: string, discordUserId: string, roleId: string): Promise<"ok" | "gone" | "failed">;
    addRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
}

const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/** Builds the tick: takes back the roles whose time ran out, never one that was renewed meanwhile. */
export function createShopRolesTick(deps: ShopRolesDeps): () => Promise<void> {
    /** Grant key -> when to try again. Lives in memory, so a restart tries everything once more. */
    const retryAt = new Map<string, number>();
    return async () => {
        const now = deps.now();
        for (const [key, at] of retryAt) if (at <= now.getTime()) retryAt.delete(key);
        const due = await deps.getDueGrants(now, DUE_READ);

        let handled = 0;
        for (const grant of due) {
            if (handled >= HANDLED_PER_TICK) break;
            const { guildId, discordUserId, roleId } = grant;
            const key = `${guildId}:${discordUserId}:${roleId}`;
            if (retryAt.has(key)) continue;
            handled++;
            try {
                // A renewal since getDueGrants makes the grant active again: leave the role alone.
                if (await deps.getActiveGrantEnd(guildId, discordUserId, roleId, now)) continue;

                const result = await deps.removeRole(guildId, discordUserId, roleId);
                if (result === "failed") {
                    retryAt.set(key, now.getTime() + RETRY_AFTER_MS); // keep the row, try again later
                    continue;
                }

                if (!(await deps.deleteGrant(guildId, discordUserId, roleId, now))) {
                    // The row did not go: a renewal bought meanwhile (give the role back) or a refund deleted it (nothing to give back).
                    if (await deps.getActiveGrantEnd(guildId, discordUserId, roleId, now))
                        await deps.addRole(guildId, discordUserId, roleId);
                }
            } catch (err) {
                logger.error(asError(err), { guild: guildId, user: discordUserId, role: roleId });
            }
        }
    };
}

/** What the rejoin re-grant needs, injected for tests. */
export interface RegrantDeps {
    now(): Date;
    getMemberActiveGrants(guildId: string, discordUserId: string, now: Date): Promise<Array<{ roleId: string; endsAt: Date }>>;
    addRole(guildId: string, discordUserId: string, roleId: string): Promise<void>;
}

function discordDeps(client: BotClient) {
    return {
        async removeRole(guildId: string, discordUserId: string, roleId: string): Promise<"ok" | "gone" | "failed"> {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return "gone";
            try {
                const member = await guild.members.fetch(discordUserId);
                if (!member.roles.cache.has(roleId)) return "ok";
                await member.roles.remove(roleId, "Shop: timed role ran out");
                return "ok";
            } catch (err) {
                const code = (err as { code?: unknown } | null)?.code;
                if (typeof code === "number" && GONE_CODES.has(code)) return "gone";
                logger.error(asError(err), { guild: guildId, user: discordUserId, role: roleId });
                return "failed";
            }
        },
        async addRole(guildId: string, discordUserId: string, roleId: string): Promise<void> {
            const member = await client.guilds.cache.get(guildId)?.members.fetch(discordUserId);
            await member?.roles.add(roleId, "Shop: timed role renewed");
        },
    };
}

/** Repository deps load lazily so importing this file doesn't pull the real database in. */
async function defaultDeps(client: BotClient): Promise<ShopRolesDeps> {
    const repo = await import("../repository/purchases.repository");
    return {
        now: () => new Date(),
        getDueGrants: repo.getDueGrants,
        getActiveGrantEnd: repo.getActiveGrantEnd,
        deleteGrant: repo.deleteGrant,
        ...discordDeps(client),
    };
}

/** Gives a returning member every running timed role back for the time left. Errors are logged, never thrown. */
export async function regrantOnJoin(member: GuildMember, deps?: RegrantDeps): Promise<void> {
    try {
        const d: RegrantDeps = deps ?? {
            now: () => new Date(),
            getMemberActiveGrants: (await import("../repository/purchases.repository")).getMemberActiveGrants,
            addRole: async (_guildId, _discordUserId, roleId) => {
                await member.roles.add(roleId, "Shop: timed role kept after rejoin");
            },
        };
        const grants = await d.getMemberActiveGrants(member.guild.id, member.id, d.now());
        for (const { roleId } of grants) {
            try {
                await d.addRole(member.guild.id, member.id, roleId);
            } catch (err) {
                logger.error(asError(err), { guild: member.guild.id, user: member.id, role: roleId });
            }
        }
    } catch (err) {
        logger.error(asError(err), { guild: member.guild.id, user: member.id });
    }
}

let tick: (() => Promise<void>) | null = null;

export const shopRolesWorker = defineWorker({
    name: "shop-roles",
    intervalMs: settings.workers.shopRolesTickMs,
    run: async (client) => {
        tick ??= createShopRolesTick(await defaultDeps(client));
        await tick();
    },
});
