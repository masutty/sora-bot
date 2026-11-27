import { getEnabledMerchants } from "../constants/merchants.constants";
import type { EmbedLike } from "./types";

/**
 * What marks a merchant report even when no registered name is read. Narrow on purpose, since it
 * counts as macro time: a settings dump saying "Merchant: ON", or an account named after a
 * merchant, must not match.
 */
const GENERIC_TITLE = /\bmerchant (?:detected|arrived|items|has arrived)\b/i;
const DETECTED_FIELD = /^detected merchant\b/i;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const textsOf = (embed: EmbedLike) => [embed.title, embed.description, ...(embed.fields?.map((f) => f.value) ?? [])];

const hasDetectedField = (embed: EmbedLike) => embed.fields?.some((f) => f.name && DETECTED_FIELD.test(f.name)) ?? false;

/**
 * The merchant a report names, in a form clear enough to record and ping a role for:
 * "Merchant Arrived - X", "X has arrived", or a "Detected Merchant ..." field with the name in the
 * title or description. A name on its own is not enough.
 */
function readName(embed: EmbedLike): string | null {
    for (const merchant of getEnabledMerchants()) {
        const names = [...new Set([merchant.label, merchant.key])].map(escapeRegex).join("|");
        const explicit = new RegExp(
            `\\bmerchant\\s+(?:arrived|items|detected)\\s*[-:]\\s*(?:${names})\\b|\\b(?:${names})\\s+has\\s+arrived\\b`,
            "i",
        );
        // Markdown between the words ("**Mari** has arrived") is not part of the sentence.
        if (textsOf(embed).some((text) => text && explicit.test(text.replace(/[*_~`]/g, "")))) return merchant.key;
        if (hasDetectedField(embed) && new RegExp(`\\b(?:${names})\\b`, "i").test(`${embed.title ?? ""} ${embed.description ?? ""}`))
            return merchant.key;
    }
    return null;
}

/** `null` when the embed is no merchant report; `name` is `null` when it is one but names none clearly. */
export function readMerchant(embed: EmbedLike): { name: string | null } | null {
    const name = readName(embed);
    if (name) return { name };

    const names = getEnabledMerchants().map((m) => escapeRegex(m.label));
    const namedTitle = names.length > 0 && new RegExp(`\\b(?:${names.join("|")})\\b`, "i").test(embed.title ?? "");
    const arrival = textsOf(embed).some((text) => text && /\b(?:mari|jester|rin)\s+has arrived\b/i.test(text));
    return namedTitle || arrival || GENERIC_TITLE.test(embed.title ?? "") || hasDetectedField(embed) ? { name: null } : null;
}
