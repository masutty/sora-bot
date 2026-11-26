import { settings } from "../settings";
import { ModerationError, type Threshold, type ThresholdAction } from "../types";
import { splitDuration } from "./parse-args";

const ACTIONS: readonly string[] = ["none", "mute", "kick", "ban"];

/** A Threshold from the modal's three texts; throws ModerationError with what to fix. */
export function parseThreshold(input: { warns: string; action: string; duration: string }): Threshold {
    const warns = Number(input.warns.trim());
    if (!Number.isInteger(warns) || warns < 1) throw new ModerationError("Warns must be a whole number from 1.");
    const word = input.action.trim().toLowerCase() || "none";
    if (!ACTIONS.includes(word)) throw new ModerationError("Action must be none, mute, kick or ban.");
    const action = word === "none" ? null : (word as ThresholdAction);
    const text = input.duration.trim();
    let durationS: number | null = null;
    if ((action === "mute" || action === "ban") && text !== "") {
        const split = splitDuration(text);
        if (split.seconds === null || split.reason !== "") throw new ModerationError("Duration needs a unit, like 30m, 12h or 7d.");
        durationS = split.seconds;
    }
    if (action === "ban" && durationS !== null && durationS > settings.maxLongSeconds) {
        throw new ModerationError("A ban lasts 365 days at most.");
    }
    if (action === "mute") {
        if (durationS === null) throw new ModerationError("A mute needs a duration.");
        if (durationS > settings.maxMuteSeconds) throw new ModerationError("A mute lasts 28 days at most.");
    }
    return { warns, action, durationS };
}

/** The ladder with `next` added, or replacing the Threshold at `replacing` warns; refuses a repeated count. */
export function withThreshold(ladder: Threshold[], next: Threshold, replacing: number | null): Threshold[] {
    const others = ladder.filter((t) => t.warns !== replacing);
    if (others.some((t) => t.warns === next.warns)) throw new ModerationError(`There is already a Threshold at ${next.warns} warns.`);
    if (replacing === null && ladder.length >= settings.maxThresholds) {
        throw new ModerationError(`The ladder holds ${settings.maxThresholds} Thresholds at most.`);
    }
    return [...others, next].sort((a, b) => a.warns - b.warns);
}
