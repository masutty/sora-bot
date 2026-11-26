/**
 * The macro-parsers subsystem's only entry point - everything outside this folder imports from
 * here, never from an individual parser file.
 */
export { detectMacroParser } from "./macro-parser.registry";
export { type BiomeExtraction, type EmbedLike, type ExtractionStep, MacroParser } from "./types";
export { inspectMessage, isMerchantReport, type MessageInspection, parseEvent, type WebhookMessageLike } from "./webhook-event.parser";
