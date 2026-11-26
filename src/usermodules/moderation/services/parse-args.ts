import { parseDuration } from "@/utils/duration";

const NAMED_REASON = /^reason:\s*/i;
const WEIGHT_TOKEN = /^(\d+)x(?:\s+|$)/i;

/** `reason:` forces the rest of the text to be the reason; returns it, or `null` when the prefix is absent. */
function namedReason(rest: string): string | null {
    return NAMED_REASON.test(rest) ? rest.replace(NAMED_REASON, "").trim() : null;
}

/** A leading `Nx` (N integer >= 1) is the warn weight; `x3` or `0x` is just text. */
export function splitWeight(rest: string): { weight: number; reason: string } {
    const text = rest.trim();
    const forced = namedReason(text);
    if (forced !== null) return { weight: 1, reason: forced };
    const match = WEIGHT_TOKEN.exec(text);
    const weight = match ? Number(match[1]) : 0;
    if (!match || weight < 1) return { weight: 1, reason: text };
    const after = text.slice(match[0].length).trim();
    return { weight, reason: namedReason(after) ?? after };
}

/** The leading token is a duration only when it has a unit letter (`30m`, `1h30m`, `7d`); a bare number is not. */
export function splitDuration(rest: string): { seconds: number | null; reason: string } {
    const text = rest.trim();
    const forced = namedReason(text);
    if (forced !== null) return { seconds: null, reason: forced };
    const [token = "", ...others] = text.split(/\s+/);
    const seconds = /[a-z]/i.test(token) ? parseDuration(token, "m") : null;
    if (seconds === null) return { seconds: null, reason: text };
    const after = others.join(" ");
    return { seconds, reason: namedReason(after) ?? after };
}
