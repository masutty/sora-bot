import { ContainerBuilder, MessageFlags } from "discord.js";
import { type CommandContext, defineView, paginationHandlers, paginationRow, type ViewDefinition, type ViewPayload } from "@/define";
import { EmbedFormatter, NO_PINGS, unix } from "@/utils/format";
import { getSessionsCovering } from "../repository/activity.repository";
import { getUserByDiscordId } from "../repository/users.repository";
import { formatFindLine, loadRareFinds } from "../services/rare-finds.service";
import type { ActivitySessionRow, RareFind } from "../types";

export const RARE_FINDS_PER_PAGE = 10;

export interface RareFindsInput {
    username: string;
    guildId: string;
    /** Every rare find of the member, newest first - fake ones included. */
    finds: RareFind[];
    /** The member's sessions that cover those finds. */
    sessions: ActivitySessionRow[];
}

interface RareFindsState extends RareFindsInput {
    page: number;
}

/** Number of pages for `count` finds (at least 1). */
export function rareFindsPageCount(count: number): number {
    return Math.max(1, Math.ceil(count / RARE_FINDS_PER_PAGE));
}

/** One page (0-based) of the history: finds grouped by session - or by date when outside any session - newest first. */
export function buildRareFindsPage(
    username: string,
    guildId: string,
    finds: RareFind[],
    sessions: ActivitySessionRow[],
    page: number,
): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    const title = `## \`${username}\`'s Rare Finds`;
    if (finds.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent(`${title}\nNo rare finds yet.`));
        return container;
    }

    const slice = finds.slice(page * RARE_FINDS_PER_PAGE, (page + 1) * RARE_FINDS_PER_PAGE);
    const groups: Array<{ header: string; lines: string[] }> = [];
    for (const f of slice) {
        const t = f.at.getTime();
        const session = sessions.find((s) => t >= s.started_at.getTime() && t <= s.ended_at.getTime());
        const header = session ? `**Session** \`#${session.id}\` · <t:${unix(session.started_at)}:D>` : `<t:${unix(f.at)}:D>`;
        const last = groups[groups.length - 1];
        const lines = formatFindLine(guildId, f).split("\n");
        if (last?.header === header) last.lines.push(...lines);
        else groups.push({ header, lines });
    }

    const body = groups.map((g) => `${g.header}\n${g.lines.map((l) => `> ${l}`).join("\n")}`).join("\n\n");
    container.addTextDisplayComponents((td) => td.setContent(`${title}\n${body}`));
    return container;
}

/** Paginated Rare Find history of one member. */
export function rareFindsView(username: string): ViewDefinition<RareFindsState, void, RareFindsInput> {
    return defineView<RareFindsState, void, RareFindsInput>({
        name: "biomehunt.rare-finds",
        initial: (input) => ({ ...input, username, page: 0 }),
        render: (state, kit): ViewPayload => {
            const pages = rareFindsPageCount(state.finds.length);
            return {
                flags: MessageFlags.IsComponentsV2,
                components: [
                    buildRareFindsPage(state.username, state.guildId, state.finds, state.sessions, state.page),
                    ...(pages > 1 ? [paginationRow(kit, state.page, pages)] : []),
                ],
            };
        },
        on: { ...paginationHandlers<RareFindsState>({ pages: (s) => rareFindsPageCount(s.finds.length) }) },
    });
}

/** Opens a member's Rare Find history, or replies that they have no profile. Used by `/bh rare-finds`. */
export async function openRareFindsView(ctx: CommandContext, guildId: string, member: { id: string; displayName: string }): Promise<void> {
    const user = await getUserByDiscordId(guildId, member.id);
    if (!user) {
        await ctx.reply({
            ...EmbedFormatter.info("You don't have a profile yet!\n\nRun `/bh setup` to get started."),
            allowedMentions: NO_PINGS,
        });
        return;
    }
    const finds = await loadRareFinds(user.id);
    const sessions = finds.length > 0 ? await getSessionsCovering(user.id, finds[finds.length - 1].at, finds[0].at) : [];
    await ctx.open(rareFindsView(member.displayName), { username: member.displayName, guildId, finds, sessions });
}
