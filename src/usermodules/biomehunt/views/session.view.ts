import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { type CommandContext, defineView, type HandlerContext, type ViewDefinition, type ViewPayload } from "@/define";
import { EmbedFormatter, formatCodeblock, formatTime, NO_PINGS, unix } from "@/utils/format";
import { getBiomeCountsInRange, getSessionInGuild } from "../repository/activity.repository";
import { findsInSession, formatFindLine, loadRareFinds } from "../services/rare-finds.service";
import type { ActivitySessionRow, RareFind } from "../types";
import { ansiBiomeLine } from "./session-end.view";

export interface SessionViewInput {
    guildId: string;
    session: ActivitySessionRow;
    discordUserId: string;
    /** The session's rare finds - fake ones included, labelled by their result. */
    finds: RareFind[];
    /** Counted biomes only (fake finds excluded). */
    biomes: Array<{ biome: string; count: number }>;
}

type SessionViewState = SessionViewInput;

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

/** One session's card: who, when, its rare finds (if any) and the biomes it counted. */
export function buildSessionContainer(input: SessionViewInput): ContainerBuilder {
    const { guildId, session, discordUserId, finds, biomes } = input;
    const container = new ContainerBuilder().setAccentColor(0x5865f2);

    container.addTextDisplayComponents((td) =>
        td.setContent(
            `## Session \`#${session.id}\` · \`${formatTime(session.duration_seconds)}\`\n<@${discordUserId}> · <t:${unix(session.started_at)}:f> → <t:${unix(session.ended_at)}:t>`,
        ),
    );
    addDivider(container);

    if (finds.length > 0) {
        const quote = finds
            .flatMap((f) => formatFindLine(guildId, f).split("\n"))
            .map((line) => `> ${line}`)
            .join("\n");
        container.addTextDisplayComponents((td) => td.setContent(`**Rare finds**\n${quote}`));
        addDivider(container);
    }

    const biomesBody =
        biomes.length > 0
            ? formatCodeblock(biomes.map((b) => ansiBiomeLine(b.biome, b.count)).join("\n"), "ansi")
            : "*No biomes recorded.*";
    container.addTextDisplayComponents((td) => td.setContent(`**Biomes found**\n${biomesBody}`));

    return container;
}

/**
 * Read-only card for one session. `back` adds a Back button that ends the view, for opening it as a
 * child from a Sessions tab.
 */
export function sessionView(opts: { back: boolean }): ViewDefinition<SessionViewState, void, SessionViewInput> {
    return defineView<SessionViewState, void, SessionViewInput>({
        name: "biomehunt.session",
        initial: (input) => input,
        render: (state, kit): ViewPayload => ({
            flags: MessageFlags.IsComponentsV2,
            components: [buildSessionContainer(state), ...(opts.back ? [kit.row(kit.button("back", (b) => b.setLabel("Back")))] : [])],
        }),
        on: { back: (c) => c.done() },
    });
}

/** Loads a session of this guild with its finds and counted biomes - `null` for an unknown or other-guild id. */
export async function loadSessionInput(guildId: string, sessionId: number): Promise<SessionViewInput | null> {
    const row = await getSessionInGuild(guildId, sessionId);
    if (!row) return null;
    const { discord_user_id: discordUserId, ...session } = row;
    const [allFinds, biomes] = await Promise.all([
        loadRareFinds(session.user_id),
        getBiomeCountsInRange(session.user_id, session.started_at, session.ended_at),
    ]);
    return { guildId, session, discordUserId, finds: findsInSession(allFinds, session), biomes };
}

/**
 * Opens a session picked from a Sessions tab as a child view. Does nothing for an id that is not on
 * the current page; notifies when the session is gone. The tab's state is untouched, so it comes back as it was.
 */
export async function openSessionFromTab(
    c: Pick<HandlerContext<never, never>, "open" | "notify">,
    guildId: string,
    sessionId: number,
    pageSessionIds: number[],
    deps: { loadSessionInput: typeof loadSessionInput } = { loadSessionInput },
): Promise<void> {
    if (!pageSessionIds.includes(sessionId)) return;
    const input = await deps.loadSessionInput(guildId, sessionId);
    if (!input) {
        await c.notify(`No session \`#${sessionId}\` on this server.`);
        return;
    }
    await c.open(sessionView({ back: true }), input);
}

/** Opens `sessionView` on a session, or replies with the not-found error. Used by `/bh session`. */
export async function openSessionView(ctx: CommandContext, guildId: string, sessionId: number): Promise<void> {
    const input = await loadSessionInput(guildId, sessionId);
    if (!input) {
        await ctx.reply({ ...EmbedFormatter.error(`No session \`#${sessionId}\` on this server.`), allowedMentions: NO_PINGS });
        return;
    }
    await ctx.open(sessionView({ back: false }), input);
}
