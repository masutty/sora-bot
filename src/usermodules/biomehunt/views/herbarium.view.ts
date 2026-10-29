import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import { type CommandContext, defineView, type RenderKit, type ViewDefinition, type ViewPayload } from "@/define";
import { EmbedFormatter, NO_PINGS } from "@/utils/format";
import { FLOWER_META, FLOWERS_BY_RARITY, FlowerRarity, RARITY_COLOR } from "../constants/flowers.constants";
import { isFlagEnabled } from "../repository/flags.repository";
import { getHerbarium } from "../repository/flowers.repository";
import { getUserByDiscordId } from "../repository/users.repository";
import { applyFlowerToWebhook } from "../services/flower.service";
import { BiomeHuntError, type UserFlowerRow } from "../types";
import { flowerAttachment, isRerollActive } from "./reroll.view";

/** Container accent when the member has no Flower. */
const NO_FLOWER_COLOR = 0x5865f2;

/** Discord's cap on options in one select. */
const SELECT_MAX_OPTIONS = 25;

const RARITIES = Object.values(FlowerRarity);
/** The rarities in the second select when the Equip options don't fit in one. */
const HIGH_RARITIES: ReadonlySet<FlowerRarity> = new Set([
    FlowerRarity.EPIC,
    FlowerRarity.LEGENDARY,
    FlowerRarity.MYTHICAL,
    FlowerRarity.RNGESUS,
]);
const TOTAL_FLOWERS = Object.keys(FLOWER_META).length;

/** What the View needs that would otherwise be a DB/webhook call or module state, injected so tests never touch them. */
export interface HerbariumDeps {
    /** Puts the Flower on the member's macro webhook and saves it as their current one. */
    applyFlower(flower: string): Promise<void>;
    /** The member has a reroll open - equipping would race its webhook edit. */
    isRerolling(): boolean;
}

export interface HerbariumInput {
    /** Discord id of the member whose Herbarium this is. */
    discordUserId: string;
    /** The member's current Flower. */
    flower: string | null;
    /** Times got per collected Flower. */
    rows: Array<Pick<UserFlowerRow, "flower" | "times">>;
    /** Whether the viewer owns this Herbarium - only then can they equip. */
    own: boolean;
}

interface HerbariumState {
    discordUserId: string;
    flower: string | null;
    /** Times got, by Flower key. */
    times: Map<string, number>;
    own: boolean;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Collected Flowers (except the equipped one) in rarity order, split in two groups when they don't fit one select. */
function equipOptions(state: HerbariumState): string[][] {
    const keys = RARITIES.flatMap((r) => FLOWERS_BY_RARITY[r]).filter((k) => state.times.has(k) && k !== state.flower);
    if (keys.length === 0) return [];
    if (keys.length <= SELECT_MAX_OPTIONS) return [keys];
    const low = keys.filter((k) => !HIGH_RARITIES.has(FLOWER_META[k].rarity));
    const high = keys.filter((k) => HIGH_RARITIES.has(FLOWER_META[k].rarity));
    return [low, high].filter((g) => g.length > 0).map((g) => g.slice(0, SELECT_MAX_OPTIONS));
}

function rarityBlock(state: HerbariumState, rarity: FlowerRarity): string {
    const keys = FLOWERS_BY_RARITY[rarity];
    const owned = keys.filter((k) => state.times.has(k)).length;
    const flowers = keys.map((k) => {
        const times = state.times.get(k);
        if (!times) return "???";
        const label = k === state.flower ? `**${FLOWER_META[k].label}**` : FLOWER_META[k].label;
        return times > 1 ? `${label} ×${times}` : label;
    });
    return `**${capitalize(rarity)}** \`${owned}/${keys.length}\`\n${flowers.join(" · ")}`;
}

function placeholder(groups: number, index: number): string {
    if (groups === 1) return "Equip a Flower";
    return index === 0 ? "Equip a Flower: Common to Rare" : "Equip a Flower: Epic and rarer";
}

function render(state: HerbariumState, kit: RenderKit): ViewPayload {
    const meta = state.flower ? FLOWER_META[state.flower] : undefined;
    const { files, thumbnailAttachment } = flowerAttachment(state.flower);
    const container = new ContainerBuilder().setAccentColor(meta ? RARITY_COLOR[meta.rarity] : NO_FLOWER_COLOR);
    const divider = () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    const collected = [...state.times.keys()].filter((k) => FLOWER_META[k]).length;
    const head = `## Herbarium\n<@${state.discordUserId}> · \`${collected}/${TOTAL_FLOWERS}\` collected`;
    if (thumbnailAttachment) {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(head))
                .setThumbnailAccessory((thumb) => thumb.setURL(`attachment://${thumbnailAttachment}`)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(head));
    }

    for (const rarity of RARITIES) {
        divider();
        container.addTextDisplayComponents((td) => td.setContent(rarityBlock(state, rarity)));
    }

    const groups = state.own ? equipOptions(state) : [];
    const rows = groups.map((keys, i) =>
        kit.row(
            kit.stringSelect(`equip:${i}`, (s) =>
                s
                    .setPlaceholder(placeholder(groups.length, i))
                    .addOptions(
                        keys.map((k) => ({ label: FLOWER_META[k].label, value: k, description: capitalize(FLOWER_META[k].rarity) })),
                    ),
            ),
        ),
    );

    return { flags: MessageFlags.IsComponentsV2, components: [container, ...rows], files, allowedMentions: NO_PINGS };
}

/** A member's Herbarium: every Flower they have got, by rarity - and, on their own, a way to equip any of them for free. */
export function herbariumView(deps: HerbariumDeps): ViewDefinition<HerbariumState, void, HerbariumInput> {
    const equip = async (c: { state: HerbariumState; values: string[]; notify(content: string): Promise<void> }) => {
        const flower = c.values[0];
        if (!c.state.own || !c.state.times.has(flower) || flower === c.state.flower) return;
        if (deps.isRerolling()) {
            await c.notify("Finish your reroll first.");
            return;
        }
        try {
            await deps.applyFlower(flower);
        } catch (err) {
            await c.notify(err instanceof BiomeHuntError ? err.message : "Something went wrong applying your Flower.");
            return;
        }
        c.state.flower = flower;
    };

    return defineView<HerbariumState, void, HerbariumInput>({
        name: "biomehunt.herbarium",
        initial: (input) => ({
            discordUserId: input.discordUserId,
            flower: input.flower,
            times: new Map(input.rows.map((r) => [r.flower, r.times])),
            own: input.own,
        }),
        render,
        on: { "equip:0": equip, "equip:1": equip },
    });
}

/**
 * Opens a member's Herbarium - or replies with the matching notice (flag off, no profile). Used by
 * `/bh herbarium`. Only the member themself gets the Equip select.
 */
export async function openHerbariumView(
    ctx: CommandContext,
    client: BotClient,
    guildId: string,
    member: { id: string },
    viewerId: string,
): Promise<void> {
    if (!(await isFlagEnabled(guildId, "EXPERIMENT_WEBHOOK_FLOWERS"))) {
        await ctx.reply(EmbedFormatter.error("Flowers aren't available on this server."));
        return;
    }

    const own = member.id === viewerId;
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) {
        const text = own
            ? "You don't have a profile yet!\n\nRun `/bh setup` to get started."
            : `<@${member.id}> doesn't have a profile yet.`;
        await ctx.reply({ ...EmbedFormatter.info(text), allowedMentions: NO_PINGS });
        return;
    }

    const rows = await getHerbarium(user.id);
    const deps: HerbariumDeps = {
        applyFlower: (flower) => applyFlowerToWebhook(client, user.id, flower),
        isRerolling: () => isRerollActive(member.id),
    };
    await ctx.open(herbariumView(deps), { discordUserId: member.id, flower: user.flower, rows, own });
}
