import { deleteAllSessionsForUser, deleteSessionById } from "../repository/activity";
import { getUserByDiscordId } from "../repository/users";
import { BiomeHuntError } from "../types";

export async function sessionDeleteAction(guildId: string, discordUserId: string, sessionId: number): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const deleted = await deleteSessionById(user.id, sessionId);
    if (!deleted) throw new BiomeHuntError(`No session #${sessionId} found for <@${discordUserId}>.`);
    return `Session #${sessionId} deleted for <@${discordUserId}>.`;
}

export async function sessionClearAction(guildId: string, discordUserId: string): Promise<string> {
    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const count = await deleteAllSessionsForUser(user.id);
    if (count === 0) throw new BiomeHuntError(`<@${discordUserId}> has no session history to clear.`);
    return `Cleared ${count} session(s) for <@${discordUserId}>.`;
}
