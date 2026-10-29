import type { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import {
    defineView,
    type HandlerContext,
    paginationHandlers,
    paginationRow,
    type RenderKit,
    type ViewDefinition,
    type ViewPayload,
} from "@/define";
import { NO_PINGS, unix } from "@/utils/format";
import { formatBiomeName } from "../constants/biomes.constants";
import { getReviewQueue, type ReviewQueueRow } from "../repository/votes.repository";
import { VoteStatus } from "../types";
import type { VoteReviewDeps, VoteReviewInput, voteReviewView } from "./vote-review.view";

/** Items per page - each takes two lines and a button. */
export const REVIEW_QUEUE_PER_PAGE = 5;

const ACCENT = 0x5865f2;

/** What the View needs that would otherwise be a DB read or a child View, injected so its tests touch neither. */
export interface ReviewQueueDeps {
    load(guildId: string): Promise<ReviewQueueRow[]>;
    /** The review a "Check" button opens - `voteReviewView(deps, { back: true, queue: true })`. */
    reviewView(): ReturnType<typeof voteReviewView>;
}

export interface ReviewQueueInput {
    guildId: string;
    viewerId: string;
}

interface ReviewQueueState extends ReviewQueueInput {
    items: ReviewQueueRow[];
    page: number;
}

export const defaultReviewQueueDeps = (reviewDeps: VoteReviewDeps, makeReview: typeof voteReviewView): ReviewQueueDeps => ({
    load: getReviewQueue,
    reviewView: () => makeReview(reviewDeps, { back: true, queue: true }),
});

const pageCount = (items: ReviewQueueRow[]) => Math.max(1, Math.ceil(items.length / REVIEW_QUEUE_PER_PAGE));

/** Why the vote is in the queue: `Tie`, `No votes`, `Won by 1 vote (3–2)`, `Finder had a fake`. */
export function reasonsOf(item: ReviewQueueRow): string[] {
    const reasons: string[] = [];
    if (item.status === VoteStatus.TIE) reasons.push("Tie");
    if (item.status === VoteStatus.NO_VOTES) reasons.push("No votes");
    if (Math.abs(item.real - item.fake) === 1)
        reasons.push(`Won by 1 vote (${Math.max(item.real, item.fake)}–${Math.min(item.real, item.fake)})`);
    if (item.finderHadFake) reasons.push("Finder had a fake");
    return reasons;
}

function queueContainer(state: ReviewQueueState, kit: RenderKit): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(ACCENT);
    if (state.items.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("Nothing to review."));
        return container;
    }
    container.addTextDisplayComponents((td) => td.setContent("**Review queue**"));
    const from = state.page * REVIEW_QUEUE_PER_PAGE;
    state.items.slice(from, from + REVIEW_QUEUE_PER_PAGE).forEach((item, i) => {
        container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        const finder = item.finderDiscordId ? `<@${item.finderDiscordId}>` : "*unknown*";
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) =>
                    td.setContent(
                        `**${formatBiomeName(item.biome)}** · ${finder} · <t:${unix(item.createdAt)}:R>\n${reasonsOf(item).join(" · ")}`,
                    ),
                )
                .setButtonAccessory(kit.button(`check:${i}`, (b) => b.setLabel("Check").setStyle(ButtonStyle.Secondary))),
        );
    });
    return container;
}

/**
 * `/admin check-vote` without an id: the server's recent closed votes worth a second look, five per
 * page. "Check" opens the vote's review as a child and reloads the queue when it returns, so a vote
 * that was marked or passed with "Looks fine" drops out.
 */
export function reviewQueueView(deps: ReviewQueueDeps): ViewDefinition<ReviewQueueState, void, ReviewQueueInput> {
    const check = async (c: HandlerContext<ReviewQueueState, void>, slot: number) => {
        const item = c.state.items[c.state.page * REVIEW_QUEUE_PER_PAGE + slot];
        if (!item) return;
        const { guildId, viewerId } = c.state;
        const input: VoteReviewInput = { id: item.id, guildId, viewerId };
        await c.open(deps.reviewView(), input);
        c.state.items = await deps.load(guildId);
        c.state.page = Math.min(c.state.page, pageCount(c.state.items) - 1);
    };

    return defineView<ReviewQueueState, void, ReviewQueueInput>({
        name: "biomehunt.review-queue",
        initial: async (input) => ({ ...input, items: await deps.load(input.guildId), page: 0 }),
        render: (state, kit): ViewPayload => {
            const pages = pageCount(state.items);
            const rows: ActionRowBuilder<ButtonBuilder>[] = pages > 1 ? [paginationRow(kit, state.page, pages)] : [];
            return { flags: MessageFlags.IsComponentsV2, components: [queueContainer(state, kit), ...rows], allowedMentions: NO_PINGS };
        },
        on: {
            ...paginationHandlers<ReviewQueueState>({ pages: (s) => pageCount(s.items) }),
            ...Object.fromEntries(
                Array.from({ length: REVIEW_QUEUE_PER_PAGE }, (_, i) => [
                    `check:${i}`,
                    (c: HandlerContext<ReviewQueueState, void>) => check(c, i),
                ]),
            ),
        },
    });
}
