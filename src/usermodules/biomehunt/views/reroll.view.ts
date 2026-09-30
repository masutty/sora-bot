import { readFileSync } from "node:fs";
import {
    type ActionRowBuilder,
    AttachmentBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type AnySelect, type CommandContext, defineView, type RenderKit, type ViewDefinition, type ViewPayload } from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { FLOWER_META, flowerAssetPath } from "../constants/flowers.constants";
import { isFlagEnabled } from "../repository/flags.repository";
import { adjustUserBalance } from "../repository/rewards.repository";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users.repository";
import { applyFlowerToWebhook, drawRandomFlower } from "../services/flower.service";
import { settings } from "../settings";
import { BiomeHuntError } from "../types";

export const REROLL_COST = 50;

/** Discord user ids with a reroll session currently open - guards against a second concurrent
 * `/bh reroll` for the same user, which would otherwise race two independent draw/apply loops
 * against the same webhook (and let two idle timeouts each try to apply their own Flower). */
const activeRerolls = new Set<string>();

/** `render` must stay pure/fast (see `view.ts`'s TSDoc), but this View re-sends the Flower PNG on
 * every render (by design - see `buildRerollPayload`'s doc). Caching the bytes here means only the
 * FIRST render of a given Flower ever touches disk; every later one (and every render of a Flower
 * already shown elsewhere in the process) just reads this Map. A fresh `AttachmentBuilder` is still
 * built each time - discord.js attachments aren't meant to be shared across payloads. */
const flowerBufferCache = new Map<string, Buffer>();

function flowerBuffer(flower: string): Buffer {
    const cached = flowerBufferCache.get(flower);
    if (cached) return cached;
    const buffer = readFileSync(flowerAssetPath(flower));
    flowerBufferCache.set(flower, buffer);
    return buffer;
}

function flowerAttachment(flower: string | null): { files: AttachmentBuilder[]; thumbnailAttachment?: string } {
    if (!flower || !FLOWER_META[flower]) return { files: [] };
    const fileName = `${flower.toLowerCase()}.png`;
    return {
        files: [new AttachmentBuilder(flowerBuffer(flower), { name: fileName })],
        thumbnailAttachment: fileName,
    };
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Flower's name as the prominent heading, its rarity as a smaller bold line underneath -
 * name is the point, rarity is context, so name has to read bigger, not the other way around. */
function flowerSectionContent(flower: string | null): string {
    if (!flower || !FLOWER_META[flower]) return "*none yet*";
    return `### ${FLOWER_META[flower].label}\n-# ${capitalize(FLOWER_META[flower].rarity)}`;
}

/**
 * Shared render for every stage of the reroll flow:
 * `-# Roll #N` (tracking line)
 * `## {heading}`
 * Flower name + rarity, with its image as a thumbnail
 * ---
 * `-# 🌱 Seeds: ...` (just the balance being spent - no Level/XP, irrelevant to a Flower reroll)
 * The Flower PNG is re-read and re-attached on every call rather than cached in state - matches
 * the old `runRerollSession`'s behavior of rebuilding the attachment on every `msg.edit`.
 */
function buildRerollPayload(
    heading: string,
    flower: string | null,
    seeds: number,
    rollCount: number,
    buttons?: ActionRowBuilder<ButtonBuilder | AnySelect>,
    note?: string,
): ViewPayload {
    const { files, thumbnailAttachment } = flowerAttachment(flower);
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents((td) => td.setContent(`-# Roll #${rollCount}`));
    container.addTextDisplayComponents((td) => td.setContent(`## ${heading}`));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    const flowerContent = flowerSectionContent(flower);
    if (thumbnailAttachment) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(flowerContent))
                .setThumbnailAccessory((thumb) => thumb.setURL(`attachment://${thumbnailAttachment}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(flowerContent));
    }
    if (note) container.addTextDisplayComponents((td) => td.setContent(`-# ${note}`));

    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents((td) => td.setContent(`-# 🌱 Seeds: ${seeds}`));

    return { flags: MessageFlags.IsComponentsV2, components: buttons ? [container, buttons] : [container], files };
}

/**
 * Everything the View needs that would otherwise be a DB/webhook call, injected so its tests never
 * hit either - `openRerollView` wires the real ones (see below).
 */
export interface RerollDeps {
    /** Spends REROLL_COST against a FRESH read of the user's balance (Seeds may have moved since
     * the screen was last drawn) - `ok: false` if that fresh balance can no longer cover it. */
    spendSeeds(): Promise<{ ok: true; seeds: number } | { ok: false }>;
    /** The one real (rate-limited) webhook edit of the whole session. */
    applyFlower(flower: string): Promise<void>;
    drawFlower(): string;
}

export interface RerollInput {
    seeds: number;
    flower: string | null;
}

interface RerollState {
    phase: "confirming" | "rolling" | "done";
    flower: string | null;
    seeds: number;
    rollCount: number;
    /** Set right before the webhook edit starts (on "Apply Now", or in `beforeExpire`'s idle
     * auto-apply) so the other path can never apply the same draw twice. */
    applying: boolean;
    /** Only set once `phase` is "done" - the exact final screen (success, error, cancelled, timed
     * out, or "no longer enough Seeds"). */
    payload?: ViewPayload;
}

function confirmingButtons(kit: RenderKit): ActionRowBuilder<ButtonBuilder | AnySelect> {
    return kit.row(
        kit.button("confirm", (b) => b.setLabel("Reroll").setStyle(ButtonStyle.Success)),
        kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Danger)),
    );
}

function rollingButtons(kit: RenderKit, canRollAgain: boolean): ActionRowBuilder<ButtonBuilder | AnySelect> {
    return kit.row(
        kit.button("again", (b) => b.setEmoji("🎲").setLabel("Roll Again").setStyle(ButtonStyle.Primary).setDisabled(!canRollAgain)),
        kit.button("apply", (b) => b.setEmoji("✅").setLabel("Apply Now").setStyle(ButtonStyle.Success)),
    );
}

function render(state: RerollState, kit: RenderKit): ViewPayload {
    if (state.phase === "done") return state.payload as ViewPayload;
    if (state.phase === "confirming") {
        return buildRerollPayload(
            `Reroll your Flower for ${REROLL_COST} 🌱 Seeds?`,
            state.flower,
            state.seeds,
            state.rollCount,
            confirmingButtons(kit),
        );
    }
    return buildRerollPayload(
        "🎲 New Flower!",
        state.flower,
        state.seeds,
        state.rollCount,
        rollingButtons(kit, state.seeds >= REROLL_COST),
        `If you don't pick one within ${settings.ui.rerollIdleMs / 1000}s, this Flower is applied automatically.`,
    );
}

/**
 * Runs the one real webhook edit and moves `state` to its final "done" screen - shared by the
 * "Apply Now" handler and `beforeExpire`'s idle auto-apply, so both build the exact same
 * success/error text. Guarded by `state.applying`: whichever path gets there first wins (the engine
 * itself already skips `beforeExpire` while a handler is running its own code - this is belt and
 * suspenders against applying the same draw twice).
 */
async function applyDraw(state: RerollState, deps: RerollDeps): Promise<void> {
    if (state.applying) return;
    state.applying = true;
    try {
        await deps.applyFlower(state.flower as string);
        state.phase = "done";
        state.payload = buildRerollPayload("✅ Flower applied!", state.flower, state.seeds, state.rollCount);
    } catch (err) {
        const text = err instanceof BiomeHuntError ? err.message : "Something went wrong applying your Flower.";
        state.phase = "done";
        state.payload = EmbedFormatter.error(text);
    }
}

/**
 * Self-service paid Flower reroll: `confirming` (nothing spent yet) -> `rolling` (each draw costs
 * REROLL_COST, looping on "Roll Again"/"Apply Now") -> `done`. Deliberately never calls the actual
 * (rate-limited) webhook edit more than once per session: every "Roll Again" click only redraws
 * client-side, still costing Seeds like the first one - the real webhook edit only happens once, on
 * "Apply Now" or on idle timeout (so Seeds already spent are never wasted just because the user
 * walked away).
 */
export function rerollView(deps: RerollDeps): ViewDefinition<RerollState, void, RerollInput> {
    return defineView<RerollState, void, RerollInput>({
        name: "biomehunt.reroll",
        initial: (input) => ({ phase: "confirming", flower: input.flower, seeds: input.seeds, rollCount: 0, applying: false }),
        timeoutMs: settings.ui.rerollIdleMs,
        render,
        on: {
            confirm: async (c) => {
                // If this throws (a DB exception, not just "not enough Seeds"), it's uncaught here:
                // the engine's generic handler-error path shows an ephemeral quip and leaves the View
                // open (unlike the old command-level error reply, which closed it right away and
                // released `activeRerolls` on the spot - here the guard stays held until this session
                // eventually expires on its own).
                const spent = await deps.spendSeeds();
                if (!spent.ok) {
                    c.state.phase = "done";
                    c.state.payload = EmbedFormatter.error("You no longer have enough Seeds.");
                    c.done();
                    return;
                }
                c.state.seeds = spent.seeds;
                c.state.rollCount = 1;
                c.state.flower = deps.drawFlower();
                c.state.phase = "rolling";
            },
            cancel: (c) => {
                c.state.phase = "done";
                c.state.payload = EmbedFormatter.warn("Reroll cancelled - nothing was spent.");
                c.done();
            },
            again: async (c) => {
                // The button is already disabled once this can't succeed - stay safe regardless.
                // Same uncaught-throw caveat as `confirm` above: a DB exception here shows the
                // engine's generic quip and leaves the View (and the guard) open, not a reply.
                const spent = await deps.spendSeeds();
                if (!spent.ok) return;
                c.state.seeds = spent.seeds;
                c.state.rollCount += 1;
                c.state.flower = deps.drawFlower();
            },
            apply: async (c) => {
                await applyDraw(c.state, deps);
                c.done();
            },
        },
        beforeExpire: (state) => (state.phase === "rolling" ? applyDraw(state, deps) : Promise.resolve()),
        onExpire: (state) => {
            if (state.phase === "done") return state.payload as ViewPayload;
            if (state.phase === "rolling") {
                // The idle timer resets on every accepted click, so landing here still "rolling"
                // means `applyDraw` above didn't finish turning it "done" - too rare (and unsafe) a
                // race to guess an outcome for; show the last screen instead of claiming an apply
                // that may not have gone through yet.
                return buildRerollPayload("🎲 New Flower!", state.flower, state.seeds, state.rollCount);
            }
            return EmbedFormatter.warn("Reroll timed out - nothing was spent.");
        },
    });
}

/**
 * Loads what the reroll needs and opens `rerollView` on it - or replies with the matching notice
 * without opening anything (already in progress, flag off, no profile, not enough Seeds, no macro
 * channel yet). The `activeRerolls` guard wraps every one of those checks AND the open View, same
 * as the old `runReroll`/`runRerollSession` split, released in `finally` regardless of how it ends.
 */
export async function openRerollView(ctx: CommandContext, client: BotClient, guildId: string, discordUserId: string): Promise<void> {
    if (activeRerolls.has(discordUserId)) {
        await ctx.reply(EmbedFormatter.error("You already have a reroll in progress - finish that one first."));
        return;
    }
    activeRerolls.add(discordUserId);
    try {
        const [flowersOn, economyOn] = await Promise.all([
            isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"),
            isFlagEnabled(guildId, "EXPERIMENT_BIOME_ECONOMY"),
        ]);
        if (!flowersOn || !economyOn) {
            await ctx.reply(EmbedFormatter.error("Flower rerolls aren't available on this server."));
            return;
        }

        const user = await getUserByDiscordId(guildId, discordUserId);
        if (!user) {
            await ctx.reply(EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."));
            return;
        }
        if (user.seeds < REROLL_COST) {
            await ctx.reply(EmbedFormatter.error(`You need ${REROLL_COST} 🌱 Seeds to reroll - you have ${user.seeds}.`));
            return;
        }

        const macroChannel = await getMacroChannelByUserId(user.id);
        if (!macroChannel) {
            await ctx.reply(EmbedFormatter.info("You don't have a macro channel yet!\n\nRun `/bh setup` to get started."));
            return;
        }

        const deps: RerollDeps = {
            spendSeeds: async () => {
                const fresh = await getUserByDiscordId(guildId, discordUserId);
                if (!fresh || fresh.seeds < REROLL_COST) return { ok: false };
                await adjustUserBalance(null, user.id, -REROLL_COST, 0);
                return { ok: true, seeds: fresh.seeds - REROLL_COST };
            },
            applyFlower: (flower) => applyFlowerToWebhook(client, user.id, flower),
            drawFlower: drawRandomFlower,
        };

        await ctx.open(rerollView(deps), { seeds: user.seeds, flower: user.flower });
    } finally {
        activeRerolls.delete(discordUserId);
    }
}
