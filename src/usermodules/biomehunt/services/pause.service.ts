import type { BotClient } from "@/core/bot-client";
import { parseDuration } from "@/utils/duration";
import { Logger } from "@/utils/logging";
import { markCurrentSessionUncounted } from "../repository/activity.repository";
import {
    claimPauseReminder,
    createPause,
    endActivePause,
    endPauseById,
    getActivePause,
    getDueTimedPauses,
    getPauseById,
    markNoticeSent,
    type PauseNotify,
    type PauseRow,
    type PauseUntil,
} from "../repository/pauses.repository";
import { getMacroChannelByUserId, getUserByDiscordId, getUserById } from "../repository/users.repository";
import { BiomeHuntError, type UserRow } from "../types";
import { sendPauseNotice, sendPauseReminder } from "./pause-notice.service";

const logger = new Logger("biomehunt.services.pause");

export type UntilInput = { kind: "interaction" } | { kind: "session_end" } | { kind: "time"; duration: string };

/** Everything the service reads and writes in the database, injected so tests use none. */
export interface PauseStore {
    getUserByDiscordId(guildId: string, discordUserId: string): Promise<UserRow | null>;
    getUserById(userId: number): Promise<UserRow | null>;
    hasMacroChannel(userId: number): Promise<boolean>;
    createPause: typeof createPause;
    endActivePause: typeof endActivePause;
    endPauseById: typeof endPauseById;
    getActivePause: typeof getActivePause;
    getPauseById: typeof getPauseById;
    markNoticeSent: typeof markNoticeSent;
    getDueTimedPauses: typeof getDueTimedPauses;
    markCurrentSessionUncounted: typeof markCurrentSessionUncounted;
}

export interface PauseDeps extends PauseStore {
    sendNotice(pause: PauseRow, userId: number): Promise<boolean>;
    claimPauseReminder: typeof claimPauseReminder;
    /** Points the member back at their unanswered Notice. */
    sendReminder(pause: PauseRow, userId: number): Promise<void>;
    now(): Date;
}

const repositoryStore: PauseStore = {
    getUserByDiscordId,
    getUserById,
    hasMacroChannel: async (userId) => (await getMacroChannelByUserId(userId)) !== null,
    createPause,
    endActivePause,
    endPauseById,
    getActivePause,
    getPauseById,
    markNoticeSent,
    getDueTimedPauses,
    markCurrentSessionUncounted,
};

export function defaultPauseDeps(client: BotClient): PauseDeps {
    return {
        ...repositoryStore,
        sendNotice: (pause, userId) => sendPauseNotice(client, userId, pause),
        claimPauseReminder,
        sendReminder: (pause, userId) => sendPauseReminder(client, userId, pause),
        now: () => new Date(),
    };
}

export function resolveUntil(input: UntilInput, userIsActive: boolean, now: Date): PauseUntil {
    if (input.kind === "interaction") return { kind: "interaction" };
    if (input.kind === "session_end") {
        if (!userIsActive) throw new BiomeHuntError("That member has no running session, so there is no session end to wait for.");
        return { kind: "session_end" };
    }
    const seconds = parseDuration(input.duration, "h");
    if (seconds === null) throw new BiomeHuntError("That duration is not valid. Try `6h`, `3d` or `1d 12h`.");
    return { kind: "time", at: new Date(now.getTime() + seconds * 1000) };
}

/** Sends the Notice and records it. Never throws: returns whether it went out. */
async function deliverNotice(deps: PauseDeps, pause: PauseRow, userId: number): Promise<boolean> {
    try {
        if (!(await deps.sendNotice(pause, userId))) return false;
        await deps.markNoticeSent(pause.id);
        return true;
    } catch (err) {
        logger.warn(`Could not send the pause Notice of pause ${pause.id}`, { error: err instanceof Error ? err.message : String(err) });
        return false;
    }
}

export async function forcePause(
    deps: PauseDeps,
    input: {
        guildId: string;
        discordUserId: string;
        message: string;
        count: boolean;
        notify: PauseNotify;
        until: UntilInput;
        /** Whether the member gets a Dismiss button. Default: yes. */
        dismissable?: boolean;
        byDiscordId: string;
    },
): Promise<string> {
    const user = await deps.getUserByDiscordId(input.guildId, input.discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");
    if (!(await deps.hasMacroChannel(user.id))) throw new BiomeHuntError("That user has no Macro Channel to pause.");

    const until = resolveUntil(input.until, user.current_status === "active", deps.now());
    const pause = await deps.createPause({
        userId: user.id,
        kind: "forced",
        message: input.message,
        byDiscordId: input.byDiscordId,
        counts: input.count,
        notify: input.notify,
        until,
        dismissable: input.dismissable ?? true,
    });
    if (!input.count) await deps.markCurrentSessionUncounted(user.id);

    let reply = `<@${input.discordUserId}> is paused.`;
    if (input.notify === "now" || user.current_status !== "active") {
        if (!(await deliverNotice(deps, pause, user.id))) reply += " Notice could not be sent.";
    }
    return reply;
}

export async function unpauseByAdmin(guildId: string, discordUserId: string, store: PauseStore = repositoryStore): Promise<string> {
    const user = await store.getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no data.");
    const ended = await store.endActivePause(user.id, "admin");
    if (!ended) throw new BiomeHuntError("That user is not paused.");
    return `<@${discordUserId}> is no longer paused.`;
}

/** A pause that just ended, with whose it was. */
export interface MemberPause {
    pause: PauseRow;
    discordUserId: string;
    guildId: string;
}

/** The running pause `clickerDiscordId` owns, or why they can't act on it. */
async function ownPause(
    pauseId: number,
    clickerDiscordId: string,
    store: PauseStore,
): Promise<{ pause: PauseRow; owner: UserRow } | "not_owner" | "not_active"> {
    const pause = await store.getPauseById(pauseId);
    if (!pause || pause.ended_at !== null) return "not_active";
    const owner = await store.getUserById(pause.user_id);
    if (!owner || owner.discord_user_id !== clickerDiscordId) return "not_owner";
    return { pause, owner };
}

const memberPause = (pause: PauseRow, owner: UserRow): MemberPause => ({
    pause,
    discordUserId: owner.discord_user_id,
    guildId: owner.guild_id,
});

export async function endPauseFromMember(
    pauseId: number,
    clickerDiscordId: string,
    store: PauseStore = repositoryStore,
): Promise<MemberPause | "not_owner" | "not_active"> {
    const own = await ownPause(pauseId, clickerDiscordId, store);
    if (typeof own === "string") return own;
    return (await store.endPauseById(pauseId, "member")) ? memberPause(own.pause, own.owner) : "not_active";
}

export async function checkDismiss(
    pauseId: number,
    clickerDiscordId: string,
    store: PauseStore = repositoryStore,
): Promise<"ok" | "not_owner" | "not_active" | "not_dismissable"> {
    const own = await ownPause(pauseId, clickerDiscordId, store);
    if (typeof own === "string") return own;
    return own.pause.dismissable ? "ok" : "not_dismissable";
}

/** Ends the pause without the member saying it is solved. */
export async function dismissPause(
    pauseId: number,
    clickerDiscordId: string,
    store: PauseStore = repositoryStore,
): Promise<MemberPause | "not_owner" | "not_active" | "not_dismissable"> {
    const own = await ownPause(pauseId, clickerDiscordId, store);
    if (typeof own === "string") return own;
    if (!own.pause.dismissable) return "not_dismissable";
    return (await store.endPauseById(pauseId, "dismissed")) ? memberPause(own.pause, own.owner) : "not_active";
}

/** An admin's cancel from the Notice itself - `null` when the pause is already over. */
export async function cancelPause(pauseId: number, store: PauseStore = repositoryStore): Promise<MemberPause | null> {
    const pause = await store.endPauseById(pauseId, "admin");
    const owner = pause ? await store.getUserById(pause.user_id) : null;
    return pause && owner ? memberPause(pause, owner) : null;
}

export async function onSessionEnded(deps: PauseDeps, userId: number): Promise<void> {
    const pause = await deps.getActivePause(userId);
    if (!pause) return;
    if (pause.notify === "session_end" && pause.notice_sent_at === null) await deliverNotice(deps, pause, userId);
    if (pause.until.kind === "session_end") {
        await deps.endPauseById(pause.id, "session_end");
        return;
    }
    // A Notice sent right away and still unanswered gets one reminder, instead of repeated pings.
    if (pause.notify === "now" && pause.notice_message_id && (await deps.claimPauseReminder(pause.id))) {
        await deps.sendReminder(pause, userId);
    }
}

export async function expireDueTimedPauses(deps: PauseDeps, now: Date): Promise<void> {
    for (const pause of await deps.getDueTimedPauses(now)) {
        try {
            await deps.endPauseById(pause.id, "expired");
        } catch (err) {
            logger.warn(`Could not expire pause ${pause.id}`, { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
