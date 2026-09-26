import { ChannelType } from "discord.js";
import { readFileSync } from "fs";
import type { BotClient } from "@/core/bot-client";
import type { Logger } from "@/utils/logging";
import { FLOWER_META, FLOWERS_BY_RARITY, FlowerRarity, flowerAssetPath, RARITY_CHANCE } from "../constants/flowers.constants";
import { getMacroChannelByUserId, setUserFlower } from "../repository/users.repository";
import { BiomeHuntError } from "../types";

/**
 * Draws a random Flower key. Rolls each rarity in RARITY_CHANCE order (rarest first); the first
 * one that hits picks uniformly among its flowers. If none hit, falls back to a common flower.
 * Independent draw every time - a Reroll can land the same Flower again on purpose (see
 * `/bh reroll` in bh.command.ts and `/bh-owner reroll-flower` in bh-owner.command.ts).
 */
export function drawRandomFlower(): string {
    for (const { rarity, chance } of RARITY_CHANCE) {
        if (Math.random() < chance) {
            const pool = FLOWERS_BY_RARITY[rarity];
            return pool[Math.floor(Math.random() * pool.length)];
        }
    }
    const fallback = FLOWERS_BY_RARITY[FlowerRarity.COMMON];
    return fallback[Math.floor(Math.random() * fallback.length)];
}

/**
 * Applies a Flower to the (newly created or adopted) webhook's name/avatar - the user's existing
 * Flower if they already have one (first-time-only assignment: a fresh channel from `/bh setup` or
 * `force-setup` must never re-roll it), otherwise a freshly drawn one. Returns `null` if the edit
 * itself failed (permissions, rate limit, channel gone mid-flight, etc) - callers then persist
 * nothing, rather than lying about a Flower that was never actually applied. Only `/bh reroll` and
 * `/bh-owner reroll-flower` are allowed to change a Flower once one is set - this never does.
 */
export async function ensureFlower(
    webhook: { edit: (opts: { name: string; avatar: Buffer }) => Promise<unknown> },
    existingFlower: string | null,
    logger: Logger,
): Promise<string | null> {
    const flower = existingFlower ?? drawRandomFlower();
    try {
        await webhook.edit({ name: FLOWER_META[flower].label, avatar: readFileSync(flowerAssetPath(flower)) });
    } catch (err) {
        logger.error(err instanceof Error ? err : new Error(String(err)));
        return null;
    }
    return flower;
}

/**
 * Applies a SPECIFIC Flower to a user's EXISTING macro webhook (name+avatar) and persists it -
 * the actual rate-limited Discord API call. Used both by `rerollFlower` (draws one and
 * applies it immediately - the `/bh-owner reroll-flower` path) and by `/bh reroll`'s
 * roll-again/apply-now flow (which draws - and lets the user re-draw - several times client-side
 * before ever calling this, so the webhook itself only gets edited once per session instead of
 * once per draw). Throws BiomeHuntError on any precondition failure (no macro channel,
 * channel/webhook inaccessible). These are the ONLY two paths allowed to change a Flower once a
 * user already has one - everything else (setup, force-setup, adopt) must leave an existing
 * Flower untouched (see `ensureFlower` above).
 */
export async function applyFlowerToWebhook(client: BotClient, userId: number, flower: string): Promise<void> {
    const macroChannel = await getMacroChannelByUserId(userId);
    if (!macroChannel) throw new BiomeHuntError("That user doesn't have a macro channel.");

    const channel = await client.channels.fetch(macroChannel.channel_id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
        throw new BiomeHuntError("Couldn't access that user's macro channel.");
    }

    const webhooks = await channel.fetchWebhooks().catch(() => null);
    const webhook = webhooks?.get(macroChannel.webhook_id);
    if (!webhook) throw new BiomeHuntError("Couldn't find that user's webhook - it may have been deleted manually.");

    await webhook.edit({ name: FLOWER_META[flower].label, avatar: readFileSync(flowerAssetPath(flower)) });
    await setUserFlower(userId, flower);
}

/** Draws a new Flower and applies it immediately - the bot-owner path (`/bh-owner reroll-flower`),
 * which has no roll-again preview step. */
export async function rerollFlower(client: BotClient, userId: number): Promise<{ flower: string }> {
    const flower = drawRandomFlower();
    await applyFlowerToWebhook(client, userId, flower);
    return { flower };
}
