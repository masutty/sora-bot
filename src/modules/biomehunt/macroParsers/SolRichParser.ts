import { DefaultMacroParser } from "./DefaultMacroParser";
import type { EmbedLike } from "./types";

/** SolRich Macro (by Finnerich) - ComponentsV2 message body (no classic embed), converted to
 * `EmbedLike` by `webhookParser.ts`'s `componentsToEmbedLike` before reaching here - otherwise
 * follows the common "Biome Started/Ended - NAME" format unmodified. */
export class SolRichParser extends DefaultMacroParser {
    constructor() {
        super("solrich");
    }

    /**
     * SolRich always puts the private server join link on a Link button - checked FIRST here,
     * unlike the base class's text-first order. The account line ("-# **[name](roblox.com/users/
     * .../profile)** ...") also contains a roblox.com URL, which would otherwise match the base
     * class's generic Roblox-link regex against embed text before the button fallback ever runs.
     */
    extractServerLink(embed: EmbedLike, components?: ReadonlyArray<unknown>): string | null {
        for (const row of components ?? []) {
            const buttons = (row as { components?: ReadonlyArray<{ url?: string | null }> })?.components ?? [];
            for (const c of buttons) {
                const match = c.url?.match(this.robloxLinkRegex);
                if (match) return match[0];
            }
        }
        return super.extractServerLink(embed, components);
    }
}
