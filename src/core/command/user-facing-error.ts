import { EmbedFormatter, NO_PINGS } from "@/utils/format";

/**
 * An expected, user-caused failure (bad input, missing config, a target that doesn't exist).
 * The command handler shows its message verbatim to the user - so it must never carry internal
 * details. Anything that is NOT a UserFacingError is logged and answered with a generic quip.
 * Modules subclass it for their own domain errors (e.g. BiomeHuntError).
 */
export class UserFacingError extends Error {}

export type CommandErrorView = { kind: "user"; message: string } | { kind: "internal" };

export function describeCommandError(err: unknown): CommandErrorView {
    if (err instanceof UserFacingError) return { kind: "user", message: err.message };
    return { kind: "internal" };
}

/**
 * The framework's error reply: an EmbedFormatter.error container that never pings - an error
 * message that happens to echo a role/user (e.g. "The role <@&123> isn't configured") must not
 * notify anyone.
 */
export function errorReply(message: string) {
    return { ...EmbedFormatter.error(message), allowedMentions: NO_PINGS };
}
