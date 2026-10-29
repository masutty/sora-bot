import { ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import { config } from "@/config";
import type { BotClient } from "@/core/bot-client";
import { defineView, type HandlerContext, type RenderKit, type ViewDefinition, type ViewPayload } from "@/define";
import { NO_PINGS, unix } from "@/utils/format";
import { getBadgeMeta } from "../constants/badges.constants";
import { formatBiomeName, getBiomeColor, getBiomeIconUrl } from "../constants/biomes.constants";
import { getNetworkGuild } from "../repository/network.repository";
import { getNetworkBallots, getNetworkMirrors, getNetworkPost, getNetworkPostByEventId } from "../repository/network-posts.repository";
import { countRewardsWithBadge, getRewardsByEventIds } from "../repository/rewards.repository";
import { getUserById } from "../repository/users.repository";
import { getBallotsForVote, getLatestVoteByEventId, getVoteById } from "../repository/votes.repository";
import { type AdminDecideResult, adminDecide } from "../services/biome-vote.service";
import { type DecideNetworkVoteResult, decideNetworkVote, defaultNetworkVoteDeps } from "../services/network-vote.service";
import {
    BiomeHuntError,
    type BiomeVoteBallotRow,
    type BiomeVoteRow,
    type NetworkBallotRow,
    type NetworkPostRow,
    VoteChoice,
    VoteStatus,
} from "../types";
import { serverNameLink } from "./network-mirror.view";
import { localVoteVerdict, type VoteVerdict, voteOutcomeLine } from "./vote-outcome";

const RED = 0xda373c;
const GREEN = 0x248046;
/** Mentions listed per side before the rest becomes `+N` - keeps a big vote under Discord's 4000-character limit. */
const MAX_MENTIONS = 40;
/** Servers listed under "Votes by server" before the rest becomes `+N more servers`. */
const MAX_SERVERS = 10;

/** What a local find's vote would take back if marked fake. */
export interface FindRewards {
    seeds: number;
    xp: number;
    /** Only when no other find still holds it. */
    badge: string | null;
}

export interface LocalSide {
    vote: BiomeVoteRow;
    ballots: BiomeVoteBallotRow[];
    finderDiscordId: string | null;
    rewards: FindRewards;
}

export interface ServerTally {
    guildId: string;
    name: string;
    inviteUrl: string | null;
    real: number;
    fake: number;
}

export interface NetworkSide {
    post: NetworkPostRow;
    ballots: NetworkBallotRow[];
    /** Most votes first. */
    servers: ServerTally[];
    /** The Mirror in the viewer's server - `null` when it has none. */
    jumpLink: string | null;
}

export interface ReviewData {
    local: LocalSide | null;
    network: NetworkSide | null;
}

/**
 * Everything the View would otherwise read from the DB or Discord, injected so its tests touch
 * neither - `defaultVoteReviewDeps(client)` wires the real ones.
 */
export interface VoteReviewDeps {
    /** The find behind a local vote id or a Network post id, as seen from `guildId` - `null` when it isn't visible there. */
    load(id: string, guildId: string): Promise<ReviewData | null>;
    /** Same CAS/reward semantics as the forward's buttons, message edit included. */
    decideLocal(voteId: string, adminDiscordId: string, choice: VoteChoice): Promise<AdminDecideResult>;
    /** The bot owner's decision on a Network vote, open or closed (edits every Mirror). */
    decideNetwork(postId: string, ownerId: string, choice: VoteChoice): Promise<DecideNetworkVoteResult>;
    isOwner(discordUserId: string): boolean;
    /** The finder's member panel, opened on Quality - `null` when they aren't in the server. */
    finderPanel(discordUserId: string): Promise<ViewDefinition<unknown, void, undefined> | null>;
}

export interface VoteReviewInput {
    /** A local vote id or a Network post id. */
    id: string;
    guildId: string;
    /** Who opened it - a bot owner also gets Mark real / Mark fake on the Network tab. */
    viewerId: string;
    /** `network` (`/network check-vote`) opens the Network tab, and fails for a find that never reached the Network. */
    tab?: Tab;
}

export type Tab = "local" | "network";

interface VoteReviewState extends ReviewData {
    id: string;
    guildId: string;
    /** The viewer is a bot owner. */
    owner: boolean;
    tab: Tab;
    /** Set while the "Mark this find real/fake?" step is showing. */
    confirm: VoteChoice | null;
}

const tally = (ballots: ReadonlyArray<{ choice: VoteChoice }>) => {
    const real = ballots.filter((b) => b.choice === VoteChoice.REAL).length;
    return { real, fake: ballots.length - real };
};

const chips = (t: { real: number; fake: number }) => `\`✅ ${t.real}\` \`❌ ${t.fake}\``;

/** `<@a>, <@b>` up to the cap, then ` +N`. */
function mentions(ids: string[]): string {
    const shown = ids.slice(0, MAX_MENTIONS).map((id) => `<@${id}>`);
    return ids.length > MAX_MENTIONS ? `${shown.join(", ")} +${ids.length - MAX_MENTIONS}` : shown.join(", ");
}

/** The local vote's current result as a verdict - `null` while open. */
function localVerdict(vote: BiomeVoteRow): VoteVerdict | null {
    return vote.status === VoteStatus.OPEN ? null : localVoteVerdict(vote.status);
}

function networkVerdict(post: NetworkPostRow, t: { real: number; fake: number }): VoteVerdict | null {
    if (post.vote_status === "open") return null;
    if (post.vote_status !== "inconclusive") return post.vote_status;
    return t.real + t.fake === 0 ? "no_votes" : "tie";
}

/** The find's title block: biome name, then who found it (and where, for a find from another server). */
function header(container: ContainerBuilder, biome: string, line: string): void {
    const text = `## ${formatBiomeName(biome)}\n${line}`;
    const icon = getBiomeIconUrl(biome);
    if (icon) {
        container.addSectionComponents((s) =>
            s.addTextDisplayComponents((td) => td.setContent(text)).setThumbnailAccessory((t) => t.setURL(icon)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(text));
    }
}

const divider = (container: ContainerBuilder) => container.addSeparatorComponents((sep) => sep.setDivider(true));

function localContainer(side: LocalSide): ContainerBuilder {
    const { vote, ballots } = side;
    const t = tally(ballots);
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(vote.biome));
    const finder = side.finderDiscordId ? `<@${side.finderDiscordId}>` : "*unknown*";
    header(container, vote.biome, `Found by ${finder} <t:${unix(vote.created_at)}:R>`);
    divider(container);
    const verdict = localVerdict(vote);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            verdict
                ? voteOutcomeLine({ verdict, tally: t, decidedBy: vote.decided_by })
                : `⏳ Voting · closes <t:${unix(vote.closes_at)}:R> ${chips(t)}`,
        ),
    );
    divider(container);
    if (ballots.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No votes yet."));
        return container;
    }
    const side_ = (choice: VoteChoice) => ballots.filter((b) => b.choice === choice).map((b) => b.user_id);
    const real = side_(VoteChoice.REAL);
    const fake = side_(VoteChoice.FAKE);
    container.addTextDisplayComponents((td) => td.setContent(`**✅ Real**\n${real.length ? mentions(real) : "None"}`));
    container.addTextDisplayComponents((td) => td.setContent(`**❌ Fake**\n${fake.length ? mentions(fake) : "None"}`));
    return container;
}

function networkContainer(side: NetworkSide, guildId: string): ContainerBuilder {
    const { post, ballots } = side;
    const t = tally(ballots);
    const container = new ContainerBuilder().setAccentColor(getBiomeColor(post.biome));
    const found = `found by <@${post.finder_discord_id}> <t:${unix(post.published_at ?? post.created_at)}:R>`;
    header(
        container,
        post.biome,
        post.origin_guild_id === guildId ? `F${found.slice(1)}` : `From ${serverNameLink(post.origin_name, post.invite_url)}, ${found}`,
    );
    divider(container);
    const verdict = networkVerdict(post, t);
    container.addTextDisplayComponents((td) =>
        td.setContent(
            verdict
                ? voteOutcomeLine({ verdict, tally: t, decidedBy: post.vote_decided_by, voters: "the Network" })
                : `⏳ Voting · closes ${post.vote_closes_at ? `<t:${unix(post.vote_closes_at)}:R> ` : ""}${chips(t)}`,
        ),
    );
    divider(container);
    if (ballots.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No votes yet."));
        return container;
    }
    const servers = side.servers.slice(0, MAX_SERVERS).map((s) => {
        const home = s.guildId === post.origin_guild_id ? "🏠 " : "";
        return `${home}${serverNameLink(s.name, s.inviteUrl)} ${chips(s)}`;
    });
    if (side.servers.length > MAX_SERVERS) servers.push(`+${side.servers.length - MAX_SERVERS} more servers`);
    container.addTextDisplayComponents((td) => td.setContent(`**Votes by server**\n${servers.join("\n")}`));

    const here = ballots.filter((b) => b.guild_id === guildId);
    const ids = (choice: VoteChoice) => here.filter((b) => b.choice === choice).map((b) => b.discord_user_id);
    const lines = [
        ids(VoteChoice.REAL).length ? `✅ ${mentions(ids(VoteChoice.REAL))}` : null,
        ids(VoteChoice.FAKE).length ? `❌ ${mentions(ids(VoteChoice.FAKE))}` : null,
    ].filter(Boolean);
    container.addTextDisplayComponents((td) => td.setContent(`**From this server**\n${lines.length ? lines.join("\n") : "No votes yet"}`));
    return container;
}

/** The biome, finder and time of the find on the tab - for the confirm step. */
function findLine(s: VoteReviewState): string {
    if (s.tab === "local" && s.local) {
        const finder = s.local.finderDiscordId ? ` by <@${s.local.finderDiscordId}>` : "";
        return `**${formatBiomeName(s.local.vote.biome)}**${finder} <t:${unix(s.local.vote.created_at)}:R>`;
    }
    const post = s.network?.post;
    return post
        ? `**${formatBiomeName(post.biome)}** by <@${post.finder_discord_id}> <t:${unix(post.published_at ?? post.created_at)}:R>`
        : "";
}

/** "Takes back `120 🌱`, `40 XP` and the Glitched badge." - empty when marking it fake takes nothing. */
export function takesBackLine(r: FindRewards): string {
    const parts = [
        r.seeds > 0 ? `\`${r.seeds.toLocaleString("en-US")} 🌱\`` : null,
        r.xp > 0 ? `\`${r.xp.toLocaleString("en-US")} XP\`` : null,
        r.badge ? `the ${getBadgeMeta(r.badge).display} badge` : null,
    ].filter((p): p is string => p !== null);
    if (parts.length === 0) return "";
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    return `Takes back ${list}.`;
}

function confirmContainer(s: VoteReviewState, choice: VoteChoice): ContainerBuilder {
    const fake = choice === VoteChoice.FAKE;
    const container = new ContainerBuilder().setAccentColor(fake ? RED : GREEN);
    const rewards =
        fake && s.tab === "local" && s.local && s.local.vote.status !== VoteStatus.COMMUNITY_FAKE ? takesBackLine(s.local.rewards) : "";
    container.addTextDisplayComponents((td) =>
        td.setContent(`**Mark this find ${fake ? "fake" : "real"}?**\n${findLine(s)}${rewards ? `\n-# ${rewards}` : ""}`),
    );
    return container;
}

/** The current result of the tab's vote - which Mark button is greyed out. */
function currentChoice(s: VoteReviewState): VoteChoice | null {
    if (s.tab === "local" && s.local) {
        const v = localVerdict(s.local.vote);
        return v === "real" ? VoteChoice.REAL : v === "fake" ? VoteChoice.FAKE : null;
    }
    const status = s.network?.post.vote_status;
    return status === "real" ? VoteChoice.REAL : status === "fake" ? VoteChoice.FAKE : null;
}

function jumpLink(s: VoteReviewState): string | null {
    if (s.tab === "local" && s.local)
        return `https://discord.com/channels/${s.local.vote.guild_id}/${s.local.vote.channel_id}/${s.local.vote.message_id}`;
    return s.network?.jumpLink ?? null;
}

function finderOf(s: VoteReviewState): string | null {
    return s.tab === "local" ? (s.local?.finderDiscordId ?? null) : (s.network?.post.finder_discord_id ?? null);
}

/**
 * `/admin check-vote`, `/network check-vote` and the "Check vote" message menu: one find's local vote
 * and, when it reached the Network, its Network vote on a second tab. Admins can Mark real / Mark fake
 * the local vote at any time (an early decision, or overriding a closed one) after a confirm step; only
 * a bot owner gets those buttons on the Network tab, where they work the same way. `back` is for opening it from the member panel's
 * Quality tab: a Back button instead of "Finder's quality".
 */
export function voteReviewView(
    deps: VoteReviewDeps,
    opts: { back?: boolean } = {},
): ViewDefinition<VoteReviewState, void, VoteReviewInput> {
    async function reload(s: VoteReviewState): Promise<void> {
        const data = await deps.load(s.id, s.guildId);
        if (data) Object.assign(s, data);
    }

    const ask = (choice: VoteChoice) => (c: HandlerContext<VoteReviewState, void>) => {
        if (c.state.tab === "network" && !deps.isOwner(c.user.id)) return;
        if (c.state.tab === "local" && !c.state.local) return;
        c.state.confirm = choice;
    };

    async function decide(c: HandlerContext<VoteReviewState, void>): Promise<void> {
        const s = c.state;
        const choice = s.confirm;
        s.confirm = null;
        if (!choice) return;
        if (s.tab === "local" && s.local) {
            const result = await deps.decideLocal(s.local.vote.id, c.user.id, choice);
            if (result.kind === "not_found") await c.notify("This vote is no longer available.");
            else if (result.kind === "already_decided") await c.notify("This vote was already decided.");
        } else if (s.tab === "network" && s.network && deps.isOwner(c.user.id)) {
            const result = await deps.decideNetwork(s.network.post.id, c.user.id, choice);
            if (result === "not_found") await c.notify("This vote is no longer available.");
            else if (result === "already_decided") await c.notify("This vote was already decided.");
        }
        await reload(s);
    }

    function actionRow(s: VoteReviewState, kit: RenderKit) {
        const current = currentChoice(s);
        const canMark = s.tab === "local" || s.owner;
        const buttons: ButtonBuilder[] = [];
        if (canMark) {
            buttons.push(
                kit.button("markReal", (b) =>
                    b
                        .setLabel("Mark real")
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(current === VoteChoice.REAL),
                ),
                kit.button("markFake", (b) =>
                    b
                        .setLabel("Mark fake")
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(current === VoteChoice.FAKE),
                ),
            );
        }
        if (opts.back) buttons.push(kit.button("back", (b) => b.setLabel("Back")));
        else if (finderOf(s)) buttons.push(kit.button("finder", (b) => b.setLabel("Finder's quality")));
        const link = jumpLink(s);
        if (link) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link).setLabel("Jump to post"));
        return kit.row(...buttons);
    }

    return defineView<VoteReviewState, void, VoteReviewInput>({
        name: "biomehunt.vote-review",
        initial: async (input) => {
            const data = await deps.load(input.id, input.guildId);
            if (!data || (!data.local && !data.network)) throw new BiomeHuntError("No vote with that id in this server.");
            if (input.tab === "network" && !data.network) throw new BiomeHuntError("That find didn't reach the Network.");
            const tab: Tab =
                input.tab ??
                (data.local && (data.local.vote.id === input.id || !data.network || data.network.post.id !== input.id)
                    ? "local"
                    : "network");
            return { ...data, id: input.id, guildId: input.guildId, owner: deps.isOwner(input.viewerId), tab, confirm: null };
        },
        render: (s, kit): ViewPayload => {
            if (s.confirm) {
                const fake = s.confirm === VoteChoice.FAKE;
                return {
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        confirmContainer(s, s.confirm),
                        kit.row(
                            kit.button("confirm", (b) =>
                                b.setLabel(fake ? "Mark fake" : "Mark real").setStyle(fake ? ButtonStyle.Danger : ButtonStyle.Success),
                            ),
                            kit.button("cancel", (b) => b.setLabel("Cancel")),
                        ),
                    ],
                    allowedMentions: NO_PINGS,
                };
            }
            const container =
                s.tab === "local" && s.local ? localContainer(s.local) : networkContainer(s.network as NetworkSide, s.guildId);
            const tabs =
                s.local && s.network
                    ? [
                          kit.row(
                              kit.button("tab:local", (b) =>
                                  b
                                      .setLabel("Local")
                                      .setStyle(s.tab === "local" ? ButtonStyle.Primary : ButtonStyle.Secondary)
                                      .setDisabled(s.tab === "local"),
                              ),
                              kit.button("tab:network", (b) =>
                                  b
                                      .setLabel("Network")
                                      .setStyle(s.tab === "network" ? ButtonStyle.Primary : ButtonStyle.Secondary)
                                      .setDisabled(s.tab === "network"),
                              ),
                          ),
                      ]
                    : [];
            return {
                flags: MessageFlags.IsComponentsV2,
                components: [container, ...tabs, actionRow(s, kit)],
                allowedMentions: NO_PINGS,
            };
        },
        on: {
            "tab:local": (c) => {
                if (c.state.local) c.state.tab = "local";
            },
            "tab:network": (c) => {
                if (c.state.network) c.state.tab = "network";
            },
            markReal: ask(VoteChoice.REAL),
            markFake: ask(VoteChoice.FAKE),
            confirm: decide,
            cancel: (c) => {
                c.state.confirm = null;
            },
            back: (c) => c.done(),
            finder: async (c) => {
                const finder = finderOf(c.state);
                if (!finder) return;
                const panel = await deps.finderPanel(finder);
                if (!panel) {
                    await c.notify("That user isn't in this server.");
                    return;
                }
                await c.open(panel, undefined);
                await reload(c.state);
            },
        },
    });
}

// ─── Loading ────────────────────────────────────────────────────────────────

async function loadLocal(vote: BiomeVoteRow): Promise<LocalSide> {
    const [ballots, finderDiscordId, rewardRows] = await Promise.all([
        getBallotsForVote(vote.id),
        vote.finder_discord_id
            ? Promise.resolve(vote.finder_discord_id)
            : getUserById(vote.finder_user_id).then((u) => u?.discord_user_id ?? null),
        vote.event_id === null ? Promise.resolve([]) : getRewardsByEventIds([vote.event_id]),
    ]);
    const rewards: FindRewards = { seeds: 0, xp: 0, badge: null };
    for (const r of rewardRows) {
        rewards.seeds += r.seeds_awarded;
        rewards.xp += r.xp_awarded;
        if (r.badge_awarded && (await countRewardsWithBadge(r.user_id, r.badge_awarded)) <= 1) rewards.badge = r.badge_awarded;
    }
    return { vote, ballots, finderDiscordId, rewards };
}

async function loadNetwork(client: BotClient, post: NetworkPostRow, guildId: string): Promise<NetworkSide> {
    const [ballots, mirrors] = await Promise.all([getNetworkBallots(post.id), getNetworkMirrors(post.id)]);
    const byGuild = new Map<string, { real: number; fake: number }>();
    for (const b of ballots) {
        const t = byGuild.get(b.guild_id) ?? { real: 0, fake: 0 };
        if (b.choice === VoteChoice.REAL) t.real++;
        else t.fake++;
        byGuild.set(b.guild_id, t);
    }
    const servers = await Promise.all(
        [...byGuild].map(async ([id, t]) => ({
            guildId: id,
            name: client.guilds.cache.get(id)?.name ?? (id === post.origin_guild_id ? post.origin_name : id),
            inviteUrl: (await getNetworkGuild(id))?.invite_url ?? null,
            ...t,
        })),
    );
    servers.sort((a, b) => b.real + b.fake - (a.real + a.fake));
    const mirror = mirrors.find((m) => m.guild_id === guildId);
    return {
        post,
        ballots,
        servers,
        jumpLink: mirror ? `https://discord.com/channels/${mirror.guild_id}/${mirror.channel_id}/${mirror.message_id}` : null,
    };
}

/** A real (not test) post that reached the Network. */
const isLivePost = (p: NetworkPostRow | null): p is NetworkPostRow =>
    !!p && !p.simulated && (p.status === "published" || p.status === "publishing");

/**
 * Resolves `id` as a local vote of `guildId` (plus its Network post, if the find went out), else as
 * a Network post the server can see - its own find, or one with a Mirror there (plus the local vote,
 * when it's the server's own find).
 */
export async function loadReview(client: BotClient, id: string, guildId: string): Promise<ReviewData | null> {
    const vote = await getVoteById(id);
    if (vote && vote.guild_id === guildId) {
        const post = vote.event_id === null ? null : await getNetworkPostByEventId(vote.event_id);
        const [local, network] = await Promise.all([loadLocal(vote), isLivePost(post) ? loadNetwork(client, post, guildId) : null]);
        return { local, network };
    }
    const post = await getNetworkPost(id);
    if (!isLivePost(post)) return null;
    const home = post.origin_guild_id === guildId;
    if (!home && !(await getNetworkMirrors(post.id)).some((m) => m.guild_id === guildId)) return null;
    const localVote = home && post.event_id !== null ? await getLatestVoteByEventId(post.event_id) : null;
    const [local, network] = await Promise.all([localVote ? loadLocal(localVote) : null, loadNetwork(client, post, guildId)]);
    return { local, network };
}

export function defaultVoteReviewDeps(client: BotClient, finderPanel: VoteReviewDeps["finderPanel"] = async () => null): VoteReviewDeps {
    return {
        load: (id, guildId) => loadReview(client, id, guildId),
        decideLocal: (voteId, adminDiscordId, choice) => adminDecide(client, voteId, adminDiscordId, choice),
        decideNetwork: (postId, ownerId, choice) => decideNetworkVote(postId, ownerId, choice, defaultNetworkVoteDeps(client)),
        isOwner: (discordUserId) => config.bot.ownerIds.includes(discordUserId),
        finderPanel,
    };
}
