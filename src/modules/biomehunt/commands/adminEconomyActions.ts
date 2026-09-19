import { isFlagEnabled } from "../repository/flags";
import { adjustUserBalance } from "../repository/rewards";
import { getUserByDiscordId } from "../repository/users";
import { BiomeHuntError } from "../types";

export async function economyGrantAction(
    guildId: string,
    discordUserId: string,
    seeds: number | null,
    xp: number | null,
): Promise<string> {
    if (!(await isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"))) {
        throw new BiomeHuntError("The economy isn't enabled for this server. Enable `EXPERIMENT_BIOME_ECONOMY` first (`flag set`).");
    }
    if (seeds === null && xp === null) {
        throw new BiomeHuntError("Provide at least one of seeds or xp.");
    }

    const user = await getUserByDiscordId(guildId, discordUserId);
    if (!user) throw new BiomeHuntError("That user has no profile yet.");

    const updated = await adjustUserBalance(null, user.id, seeds ?? 0, xp ?? 0);

    const parts: string[] = [];
    if (seeds) parts.push(`${seeds > 0 ? "+" : ""}${seeds} 🌱`);
    if (xp) parts.push(`${xp > 0 ? "+" : ""}${xp} XP`);
    return `<@${discordUserId}>: ${parts.join(", ")}. New balance: ${updated.seeds} 🌱, ${updated.xp} XP.`;
}
