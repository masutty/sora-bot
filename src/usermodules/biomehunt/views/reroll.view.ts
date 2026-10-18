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
import { FLOWER_META, FlowerRarity, flowerAssetPath, RARITY_COLOR, rarityOneIn } from "../constants/flowers.constants";
import { isFlagEnabled } from "../repository/flags.repository";
import { adjustUserBalance } from "../repository/rewards.repository";
import { getMacroChannelByUserId, getUserByDiscordId } from "../repository/users.repository";
import { applyFlowerToWebhook, drawRandomFlower } from "../services/flower.service";
import { settings } from "../settings";
import { BiomeHuntError } from "../types";

export const REROLL_COST = 50;

/** Container accent when there is no Flower to take a rarity color from. */
const NO_FLOWER_COLOR = 0x5865f2;

/** Discord user ids with a reroll session currently open - guards against a second concurrent
 * `/bh reroll` for the same user, which would otherwise race two independent draw/apply loops
 * against the same webhook (and let two idle timeouts each try to apply their own Flower). */
const activeRerolls = new Set<string>();

/** `render` must stay pure/fast (see `view.ts`'s TSDoc), but this View re-sends the Flower PNG on
 * every render (by design - see `buildCard`). Caching the bytes here means only the FIRST render of
 * a given Flower ever touches disk; every later one just reads this Map. A fresh `AttachmentBuilder`
 * is still built each time - discord.js attachments aren't meant to be shared across payloads. */
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

/** Rarities that get a find banner and a "lose it?" confirmation before searching again. */
type VeryRareRarity = FlowerRarity.LEGENDARY | FlowerRarity.MYTHICAL | FlowerRarity.RNGESUS;

interface FindBanner {
    tag: string;
    color: string;
    flavors: readonly string[];
}

const FIND_BANNERS: Record<VeryRareRarity, FindBanner> = {
    [FlowerRarity.LEGENDARY]: {
        tag: "\u001b[1;33m ★ LEGENDARY FIND ★ \u001b[0m",
        color: "\u001b[33m",
        flavors: [
            "This one doesn't grow in just any garden.",
            "You dug deep for this one.",
            "The other Flowers are jealous.",
            "Worth every Seed.",
            "Plant it where everyone can see it.",
        ],
    },
    [FlowerRarity.MYTHICAL]: {
        tag: "\u001b[1;31;40m ◆ MYTHICAL FIND ◆ \u001b[0m",
        color: "\u001b[31m",
        flavors: [
            "Gardeners talk about this one in whispers.",
            "Even the bees stopped to look.",
            "The soil still glows where it was.",
            "One in a thousand, and it picked you.",
        ],
    },
    [FlowerRarity.RNGESUS]: {
        tag: "\u001b[1;37;45m ✦ RNGESUS FIND ✦ \u001b[0m",
        color: "\u001b[35m",
        flavors: [
            "RNGesus has blessed your garden.",
            "Gold petals, earned the hard way.",
            "This shouldn't have grown here.",
            "Screenshot this. Nobody will believe you.",
            "The odds never stood a chance.",
            "Somewhere, a statistician just fainted.",
            "Your luck is now officially suspicious.",
            "One in a hundred thousand, and it's yours.",
        ],
    },
};

function veryRareRarity(flower: string | null): VeryRareRarity | null {
    const rarity = flower ? FLOWER_META[flower]?.rarity : undefined;
    return rarity && rarity in FIND_BANNERS ? (rarity as VeryRareRarity) : null;
}

/**
 * Everything the View needs that would otherwise be a DB/webhook/clock/random call, injected so its
 * tests never hit any of them - `openRerollView` wires the real ones (see below).
 */
export interface RerollDeps {
    /** Spends REROLL_COST against a FRESH read of the user's balance (Seeds may have moved since
     * the screen was last drawn) - `ok: false` (with that fresh balance) if it can no longer cover it. */
    spendSeeds(): Promise<{ ok: true; seeds: number } | { ok: false; seeds: number }>;
    /** The one real (rate-limited) webhook edit of the whole session. */
    applyFlower(flower: string): Promise<void>;
    drawFlower(): string;
    /** Picks one entry at random (the find banner's flavor line). */
    pick<T>(items: readonly T[]): T;
    /** Current time in ms - the idle auto-apply deadline shown to the user is based on it. */
    now(): number;
}

export interface RerollInput {
    seeds: number;
    flower: string | null;
}

interface RerollState {
    /** `confirming`: nothing spent yet. `found`: a drawn Flower is on screen. `losing`: asking
     * whether to give up a very rare find for another search. `done`: final screen in `payload`. */
    phase: "confirming" | "found" | "losing" | "done";
    flower: string | null;
    seeds: number;
    /** Paid searches made this session - shown on the kept card. */
    searches: number;
    /** Ansi banner lines for a very rare find (flavor picked when drawn) - `null` otherwise. */
    banner: { rarity: VeryRareRarity; flavor: string } | null;
    /** When the idle auto-apply fires (ms epoch). Refreshed by every handler, since the idle
     * timer restarts on each accepted click - stored here so `render` stays pure. */
    deadline: number;
    /** Set right before the webhook edit starts (on "Keep", or in `beforeExpire`'s idle
     * auto-apply) so the other path can never apply the same draw twice. */
    applying: boolean;
    /** Only set once `phase` is "done" - the exact final screen. */
    payload?: ViewPayload;
}

function currentLabel(flower: string | null): string {
    return flower && FLOWER_META[flower] ? FLOWER_META[flower].label : "as is";
}

interface CardOptions {
    /** Normal-text line under the Flower name. */
    second: string;
    /** Text shown under the divider. */
    footer: string;
    buttons?: ActionRowBuilder<ButtonBuilder | AnySelect>;
}

/**
 * Shared render for every stage of the flow, all inside one container whose accent is the shown
 * Flower's rarity color: optional find banner, the Flower card (name + `second` line, image as
 * thumbnail), a divider and the `footer` text. The Flower PNG is re-attached on every call.
 */
function buildCard(state: RerollState, { second, footer, buttons }: CardOptions): ViewPayload {
    const meta = state.flower ? FLOWER_META[state.flower] : undefined;
    const { files, thumbnailAttachment } = flowerAttachment(state.flower);
    const container = new ContainerBuilder().setAccentColor(meta ? RARITY_COLOR[meta.rarity] : NO_FLOWER_COLOR);
    const divider = () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    if (state.banner) {
        const { tag, color } = FIND_BANNERS[state.banner.rarity];
        container.addTextDisplayComponents((td) => td.setContent(`\`\`\`ansi\n${tag}\n${color}${state.banner?.flavor}\u001b[0m\n\`\`\``));
        divider();
    }

    // Name and second line in ONE TextDisplay, so the line sits right under the heading.
    const card = [meta ? `## ${meta.label}` : "## No Flower yet", second].filter(Boolean).join("\n");
    if (thumbnailAttachment) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(card))
                .setThumbnailAccessory((thumb) => thumb.setURL(`attachment://${thumbnailAttachment}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(card));
    }

    divider();
    container.addTextDisplayComponents((td) => td.setContent(footer));

    return { flags: MessageFlags.IsComponentsV2, components: buttons ? [container, buttons] : [container], files };
}

function rarityOf(flower: string | null): FlowerRarity | null {
    return flower ? (FLOWER_META[flower]?.rarity ?? null) : null;
}

function foundFooter(state: RerollState): string {
    return `⏳ Kept <t:${Math.floor(state.deadline / 1000)}:R>\nYou have \`${state.seeds.toLocaleString("en-US")} 🌱\` left.`;
}

function render(state: RerollState, kit: RenderKit): ViewPayload {
    if (state.phase === "done") return state.payload as ViewPayload;
    const rarity = rarityOf(state.flower);
    const label = currentLabel(state.flower);

    if (state.phase === "confirming") {
        return buildCard(state, {
            second: rarity ? capitalize(rarity) : "Nothing planted yet",
            footer: `**Search for another Flower?**\nEach search digs up a random Flower for \`${REROLL_COST} 🌱\`.`,
            buttons: kit.row(
                kit.button("confirm", (b) => b.setEmoji("🔍").setLabel("Search").setStyle(ButtonStyle.Success)),
                kit.button("cancel", (b) => b.setLabel(`Keep ${label}`).setStyle(ButtonStyle.Secondary)),
            ),
        });
    }

    const veryRare = state.banner !== null;
    const odds = rarity ? `${capitalize(rarity)} · 1 in ${rarityOneIn(rarity)}` : "";
    const losing = state.phase === "losing";
    return buildCard(state, {
        second: odds,
        footer: losing ? `**Search again and lose your ${label}?**\n${foundFooter(state)}` : foundFooter(state),
        buttons: kit.row(
            kit.button("again", (b) =>
                b
                    .setEmoji("🔍")
                    .setLabel("Search again")
                    .setStyle(veryRare ? ButtonStyle.Danger : ButtonStyle.Primary)
                    .setDisabled(!losing && state.seeds < REROLL_COST),
            ),
            kit.button("apply", (b) => b.setLabel(`Keep ${label}`).setStyle(ButtonStyle.Success)),
        ),
    });
}

function keptPayload(state: RerollState): ViewPayload {
    const rarity = rarityOf(state.flower);
    // A very rare find keeps its odds (and banner) on the kept card; the rest show the rarity only.
    const second = rarity ? (state.banner ? `${capitalize(rarity)} · 1 in ${rarityOneIn(rarity)}` : capitalize(rarity)) : "";
    const keep = `you decided to keep your **${currentLabel(state.flower)}**.`;
    const footer =
        state.searches > 0
            ? `🌱 After ${state.searches} ${state.searches === 1 ? "search" : "searches"}, ${keep}`
            : `🌱 ${capitalize(keep)}`;
    return buildCard(state, { second, footer });
}

/** Restarts the shown deadline - called by every handler that leaves the View open, since the
 * engine restarts the idle timer on each accepted click. */
function touch(state: RerollState, deps: RerollDeps): void {
    state.deadline = deps.now() + settings.ui.rerollIdleMs;
}

/** Spends and draws a new Flower into `state`. `false` (and nothing changed but the balance) if the
 * fresh balance can no longer cover it. */
async function search(state: RerollState, deps: RerollDeps): Promise<boolean> {
    const spent = await deps.spendSeeds();
    state.seeds = spent.seeds;
    if (!spent.ok) return false;
    state.searches++;
    state.flower = deps.drawFlower();
    const rarity = veryRareRarity(state.flower);
    state.banner = rarity ? { rarity, flavor: deps.pick(FIND_BANNERS[rarity].flavors) } : null;
    state.phase = "found";
    touch(state, deps);
    return true;
}

/**
 * Runs the one real webhook edit and moves `state` to its final "done" screen - shared by the
 * "Keep" handler and `beforeExpire`'s idle auto-apply, so both build the exact same success/error
 * text. Guarded by `state.applying`: whichever path gets there first wins.
 */
async function applyDraw(state: RerollState, deps: RerollDeps): Promise<void> {
    if (state.applying) return;
    state.applying = true;
    try {
        await deps.applyFlower(state.flower as string);
        state.phase = "done";
        state.payload = keptPayload(state);
    } catch (err) {
        const text = err instanceof BiomeHuntError ? err.message : "Something went wrong applying your Flower.";
        state.phase = "done";
        state.payload = EmbedFormatter.error(text);
    }
}

export function notEnoughSeedsText(seeds: number): string {
    return `You need \`${REROLL_COST} 🌱\` to search for a new Flower - you have \`${seeds} 🌱\`.`;
}

/**
 * Self-service paid Flower reroll ("search the garden"): `confirming` (nothing spent yet) ->
 * `found` (each search costs REROLL_COST, looping on "Search again"; for Legendary and rarer finds
 * that first goes through `losing`, a confirmation) -> `done`. Deliberately never calls the actual
 * (rate-limited) webhook edit more than once per session: searching again only redraws
 * client-side, still costing Seeds - the real webhook edit only happens once, on "Keep" or on idle
 * timeout (so Seeds already spent are never wasted just because the user walked away).
 */
export function rerollView(deps: RerollDeps): ViewDefinition<RerollState, void, RerollInput> {
    return defineView<RerollState, void, RerollInput>({
        name: "biomehunt.reroll",
        initial: (input) => ({
            phase: "confirming",
            flower: input.flower,
            seeds: input.seeds,
            searches: 0,
            banner: null,
            deadline: deps.now() + settings.ui.rerollIdleMs,
            applying: false,
        }),
        timeoutMs: settings.ui.rerollIdleMs,
        render,
        on: {
            confirm: async (c) => {
                // If this throws (a DB exception, not just "not enough Seeds"), it's uncaught here:
                // the engine's generic handler-error path shows an ephemeral quip and leaves the View
                // open - the guard stays held until this session eventually expires on its own.
                if (await search(c.state, deps)) return;
                c.state.phase = "done";
                c.state.payload = EmbedFormatter.error(notEnoughSeedsText(c.state.seeds));
                c.done();
            },
            cancel: (c) => {
                // Keeping the current Flower: nothing spent, nothing to apply.
                c.state.phase = "done";
                c.state.payload = c.state.flower ? keptPayload(c.state) : EmbedFormatter.warn("Nothing was spent.");
                c.done();
            },
            again: async (c) => {
                if (c.state.phase === "found" && c.state.banner) {
                    c.state.phase = "losing";
                    touch(c.state, deps);
                    return;
                }
                // The button is already disabled once this can't succeed; a fresh balance that still
                // can't cover it ends on the same error as `confirm`. Same uncaught-throw caveat.
                if (await search(c.state, deps)) return;
                c.state.phase = "done";
                c.state.payload = EmbedFormatter.error(notEnoughSeedsText(c.state.seeds));
                c.done();
            },
            apply: async (c) => {
                await applyDraw(c.state, deps);
                c.done();
            },
        },
        beforeExpire: (state) => (state.phase === "found" || state.phase === "losing" ? applyDraw(state, deps) : Promise.resolve()),
        onExpire: (state) => {
            if (state.phase === "done") return state.payload as ViewPayload;
            if (state.phase === "found" || state.phase === "losing") {
                // The idle timer resets on every accepted click, so landing here still open means
                // `applyDraw` above didn't finish turning it "done" - too rare (and unsafe) a race
                // to guess an outcome for; show the Flower without claiming an apply.
                const rarity = rarityOf(state.flower);
                return buildCard(state, { second: rarity ? capitalize(rarity) : "", footer: `🌱 **${currentLabel(state.flower)}**` });
            }
            return EmbedFormatter.warn("Reroll timed out - nothing was spent.");
        },
    });
}

/**
 * Loads what the reroll needs and opens `rerollView` on it - or replies with the matching notice
 * without opening anything (already in progress, flag off, no profile, not enough Seeds, no macro
 * channel yet). The `activeRerolls` guard wraps every one of those checks AND the open View,
 * released in `finally` regardless of how it ends.
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
            await ctx.reply(EmbedFormatter.error(notEnoughSeedsText(user.seeds)));
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
                if (!fresh || fresh.seeds < REROLL_COST) return { ok: false, seeds: fresh?.seeds ?? 0 };
                await adjustUserBalance(null, user.id, -REROLL_COST, 0);
                return { ok: true, seeds: fresh.seeds - REROLL_COST };
            },
            applyFlower: (flower) => applyFlowerToWebhook(client, user.id, flower),
            drawFlower: drawRandomFlower,
            pick: (items) => items[Math.floor(Math.random() * items.length)],
            now: Date.now,
        };

        await ctx.open(rerollView(deps), { seeds: user.seeds, flower: user.flower });
    } finally {
        activeRerolls.delete(discordUserId);
    }
}
