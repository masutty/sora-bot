/**
 * The macro-parsers subsystem's only entry point - everything outside this folder imports from
 * here, never from an individual parser file.
 */
export { detectMacroParser } from "./macro-parser.registry";
export { type BiomeExtraction, type EmbedLike, MacroParser } from "./types";
export { parseEvent, type WebhookMessageLike } from "./webhook-event.parser";
