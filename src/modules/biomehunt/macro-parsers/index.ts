import { Logger } from "@/utils/logging";
import { CoteabParser } from "./coteab.parser";
import { DroidscopeParser } from "./droidscope.parser";
import { EggsolParser } from "./eggsol.parser";
import { JJaramParser } from "./jjaram.parser";
import { MaxstellarParser } from "./maxstellar.parser";
import { MultiscopeParser } from "./multiscope.parser";
import { SolRichParser } from "./sol-rich.parser";
import { SoraMinimalParser } from "./sora-minimal.parser";
import type { MacroParser } from "./types";
import { UnknownMacroParser } from "./unknown-macro.parser";

const logger = new Logger("biomehunt.macroParsers");

const KNOWN_PARSERS: MacroParser[] = [
    new CoteabParser(),
    new MultiscopeParser(),
    new EggsolParser(),
    new MaxstellarParser(),
    new DroidscopeParser(),
    new JJaramParser(),
    new SoraMinimalParser(),
    new SolRichParser(),
];

/** Picks the macro's parser class by matching its id against the webhook embed's footer text. */
export function detectMacroParser(footer?: string | null): MacroParser {
    if (footer) {
        const f = footer.toLowerCase();
        const found = KNOWN_PARSERS.find((parser) => {
            const id = parser.id;
            const hasId = f.includes(id);
            logger.verbose(`Looking for ${id} in ${f} -> ${hasId}`);
            return hasId
        });
        if (found) return found;
    }
    return new UnknownMacroParser();
}

export { MacroParser, type BiomeExtraction, type EmbedLike } from "./types";

export { parseEvent, type WebhookMessageLike } from "./webhook-event.parser";
