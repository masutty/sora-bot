import type { Client, MessageCreateOptions } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { Logger } from "@/utils/logging";
import { getMemberNetworkGuilds, recordActivityCheck } from "../repository/network.repository";
import { getUnnotifiedNetworkAlerts, insertNetworkAlert, markNetworkAlertsNotified } from "../repository/network-posts.repository";
import { settings } from "../settings";
import { serverNameLink } from "../views/network-mirror.view";
import { type EligibilityReport, loadEligibility } from "./network-eligibility.service";
import { notifyOwners } from "./owner-dm.service";

const logger = new Logger("biomehunt.services.network-daily");

/** Discord's message length limit, minus room for the digest's header. */
const DIGEST_MAX_CHARS = 1900;

/** Everything the daily checks would otherwise call on the DB or Discord, injected so tests touch neither. */
export interface NetworkDailyDeps {
    getMemberNetworkGuilds: typeof getMemberNetworkGuilds;
    loadEligibility: (guildId: string) => Promise<EligibilityReport>;
    recordActivityCheck: typeof recordActivityCheck;
    insertNetworkAlert: typeof insertNetworkAlert;
    notifyOwners: (payload: MessageCreateOptions) => Promise<void>;
    getUnnotifiedNetworkAlerts: typeof getUnnotifiedNetworkAlerts;
    markNetworkAlertsNotified: typeof markNetworkAlertsNotified;
    guildName: (guildId: string) => string;
}

export function defaultNetworkDailyDeps(client: Client): NetworkDailyDeps {
    return {
        getMemberNetworkGuilds,
        loadEligibility: (guildId) => loadEligibility(guildId),
        recordActivityCheck,
        insertNetworkAlert,
        notifyOwners: (payload) => notifyOwners(client, payload),
        getUnnotifiedNetworkAlerts,
        markNetworkAlertsNotified,
        guildName: (guildId) => client.guilds.cache.get(guildId)?.name ?? guildId,
    };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` of `date`'s UTC calendar day. */
export function utcDay(date: Date): string {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** node-pg parses a DATE column as LOCAL midnight - read it back with local components. */
function storedDay(date: Date | null): string | null {
    return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : null;
}

/**
 * Once per UTC day per Member Server (forced ones are exempt): counts its active members and keeps
 * the below-minimum streak. When the streak reaches `lowActivityChecksToAlert`, the owners get one
 * DM (and an alert row) - removing the server stays a manual call.
 */
export async function runActivityChecks(now: Date, deps: NetworkDailyDeps): Promise<void> {
    const today = utcDay(now);
    for (const guild of await deps.getMemberNetworkGuilds()) {
        if (guild.forced || storedDay(guild.last_activity_check) === today) continue;
        try {
            const active = (await deps.loadEligibility(guild.guild_id)).facts.activeMembers;
            const low = active < settings.network.minActiveMembers ? guild.low_activity_checks + 1 : 0;
            await deps.recordActivityCheck(guild.guild_id, today, low);
            if (low !== settings.network.lowActivityChecksToAlert) continue;

            const details =
                `${serverNameLink(deps.guildName(guild.guild_id), guild.invite_url)} (\`${guild.guild_id}\`) has had fewer than ${settings.network.minActiveMembers} active members ` +
                `for ${low} daily checks in a row (now ${active}). Remove it with \`/bh-owner network remove guild_id:${guild.guild_id}\` if you want.`;
            await deps.insertNetworkAlert({
                kind: "low_activity",
                guildId: guild.guild_id,
                discordUserId: null,
                postId: null,
                details,
                notified: true,
            });
            await deps.notifyOwners({ content: `📉 **Low activity**\n${details}`, allowedMentions: NO_PINGS });
        } catch (err) {
            logger.error(err instanceof Error ? err : new Error(String(err)), { guildId: guild.guild_id });
        }
    }
}

/** In-memory only: a restart after the digest hour may send one extra digest that day - harmless, sent alerts are marked notified. */
export interface DigestState {
    lastDigestDay: string | null;
}

/** At `digestHourUtc` (or the first tick after it), once a day: one DM with every Multi Macro alert that wasn't DMed yet. */
export async function sendMultiMacroDigest(now: Date, state: DigestState, deps: NetworkDailyDeps): Promise<void> {
    const today = utcDay(now);
    if (now.getUTCHours() < settings.network.digestHourUtc || state.lastDigestDay === today) return;
    state.lastDigestDay = today;

    const alerts = await deps.getUnnotifiedNetworkAlerts("multi_macro");
    if (alerts.length === 0) return;

    const header = `🗂️ **Multi Macro digest** - ${alerts.length} case(s) since the last one\n`;
    let body = "";
    for (const alert of alerts) {
        const line = `- ${alert.details}\n`;
        if (header.length + body.length + line.length > DIGEST_MAX_CHARS) {
            body += "- ... more in `/bh-owner network lookup`\n";
            break;
        }
        body += line;
    }
    await deps.notifyOwners({ content: header + body, allowedMentions: NO_PINGS });
    await deps.markNetworkAlertsNotified(alerts.map((a) => a.id));
}

const digestState: DigestState = { lastDigestDay: null };

/** The `network-daily` Worker's tick (hourly). */
export async function runNetworkDaily(client: Client, now: Date = new Date()): Promise<void> {
    const deps = defaultNetworkDailyDeps(client);
    await runActivityChecks(now, deps);
    await sendMultiMacroDigest(now, digestState, deps);
}
