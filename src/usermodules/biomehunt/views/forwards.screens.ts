import {
    ActionRowBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { paginationRow, type RenderKit, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import {
    ALL_BIOME_CATEGORIES,
    BIOME_CATEGORY_LABELS,
    formatBiomeName,
    getAllBiomes,
    getBiomeIconUrl,
    getBiomeMeta,
} from "../constants/biomes.constants";
import { settings } from "../settings";
import { type BiomeCategory, NetworkStatus } from "../types";
import type { ForwardsState } from "./forwards.view";

export const FORWARDS_PER_PAGE = 5;

/** Tabs in display order; the admin category is never listed. */
const TAB_ORDER: BiomeCategory[] = ["weather", "biome", "event", "rare"];
export const FORWARD_TABS: Array<{ key: BiomeCategory; label: string }> = TAB_ORDER.filter(
    (key) => key !== "admin" && ALL_BIOME_CATEGORIES.includes(key),
).map((key) => ({ key, label: { weather: "Weather", biome: "Biomes", event: "Events", rare: "Rare" }[key as string] ?? key }));

/** What the tab's biomes are called in a sentence ("Apply to all 4 rare biomes?"). */
export const TAB_NOUN: Partial<Record<BiomeCategory, string>> = {
    weather: "weather biomes",
    biome: "biomes",
    event: "event biomes",
    rare: "rare biomes",
};

export const NETWORK_NOTE = "The Network needs a forward for every rare biome.";

/** The enabled biomes of a category, in registry order. */
export function tabBiomes(tab: BiomeCategory): string[] {
    return getAllBiomes()
        .filter((b) => b.enabled && b.category === tab)
        .map((b) => b.key);
}

export const forwardPages = (tab: BiomeCategory) => Math.max(1, Math.ceil(tabBiomes(tab).length / FORWARDS_PER_PAGE));

/** Whether the Network notes show: only for a server that is in the Network or asking to join. */
export const showNetworkNotes = (s: ForwardsState) => s.network === NetworkStatus.PENDING || s.network === NetworkStatus.MEMBER;

export const isRare = (biome: string) => getBiomeMeta(biome)?.category === "rare";

/** The delay that "Set for all" and a new delayed forward start with. */
export const DEFAULT_DELAY_S = settings.delayedForward.delayChoicesS.includes(30) ? 30 : settings.delayedForward.delayChoicesS[0];

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

function newContainer(color = 0x5865f2): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(color);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

const target = (channelId: string, roleId: string | null) => `<#${channelId}>${roleId ? ` · <@&${roleId}>` : ""}`;

const cantPost = (s: ForwardsState, channelId: string) => s.blocked.includes(channelId);

/** One biome's lines on the list: its Now forward, then (rare only) its delayed forward. */
function rowLines(s: ForwardsState, biome: string): string {
    const now = s.forwards[biome];
    const late = isRare(biome) ? s.delayed[biome] : undefined;
    const network = showNetworkNotes(s) && isRare(biome);

    if (!now && !late) return network ? `⚠️ Not forwarded\n-# ${NETWORK_NOTE}` : "-# Not forwarded";

    const lines: string[] = [];
    let lostAccess = false;
    const forward = (label: string, f: { channel_id: string; role_id: string | null }) => {
        if (cantPost(s, f.channel_id)) {
            lostAccess = true;
            lines.push(`⚠️ Can't post in <#${f.channel_id}>`);
        } else {
            lines.push(`${label} → ${target(f.channel_id, f.role_id)}`);
        }
    };
    if (now) forward("Now", now);
    else lines.push("Now → not forwarded");
    if (late) forward(`After ${late.delay_s}s`, late);
    if (lostAccess) lines.push("-# The bot lost access to this channel.");
    if (network && !now) lines.push(`-# ${NETWORK_NOTE}`);
    return lines.join("\n");
}

function tabsRow(s: ForwardsState, kit: RenderKit): ActionRowBuilder<ButtonBuilder> {
    return row(
        ...FORWARD_TABS.map((t) =>
            kit.button(`tab:${t.key}`, (b) =>
                b
                    .setLabel(t.label)
                    .setStyle(t.key === s.tab ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(t.key === s.tab),
            ),
        ),
    );
}

function listScreen(s: ForwardsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    const label = FORWARD_TABS.find((t) => t.key === s.tab)?.label ?? BIOME_CATEGORY_LABELS[s.tab];
    container.addTextDisplayComponents((td) => td.setContent(`**Forwards · ${label}**\nWhere each find gets posted.`));
    divider();
    const biomes = tabBiomes(s.tab);
    if (biomes.length === 0) container.addTextDisplayComponents((td) => td.setContent("No biomes in this category."));
    biomes.slice(s.page * FORWARDS_PER_PAGE, (s.page + 1) * FORWARDS_PER_PAGE).forEach((biome, slot, shown) => {
        const configured = Boolean(s.forwards[biome] || (isRare(biome) && s.delayed[biome]));
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(`**${formatBiomeName(biome)}**\n${rowLines(s, biome)}`))
                .setButtonAccessory(kit.button(`edit:${slot}`, (b) => b.setLabel(configured ? "Edit" : "Set up"))),
        );
        if (slot < shown.length - 1) divider();
    });
    const parts: Parts = [container, tabsRow(s, kit)];
    if (forwardPages(s.tab) > 1) parts.push(paginationRow(kit, s.page, forwardPages(s.tab)));
    parts.push(
        row(
            kit.button("all", (b) => b.setLabel("Set for all")),
            kit.button("close", (b) => b.setLabel("Close")),
        ),
    );
    return parts;
}

const delayOptions = (current: number | null) =>
    settings.delayedForward.delayChoicesS.map((n) => ({ label: `After ${n} seconds`, value: String(n), default: n === current }));

function editorScreen(s: ForwardsState, kit: RenderKit): Parts {
    const biome = s.biome;
    if (!biome) return listScreen(s, kit);
    const meta = getBiomeMeta(biome);
    const now = s.forwards[biome];
    const late = s.delayed[biome];
    const rare = isRare(biome);
    const { container, divider } = newContainer(meta?.color);

    const kind = rare ? "Rare biome" : (BIOME_CATEGORY_LABELS[meta?.category ?? "biome"] ?? "Biome");
    const heading = `## ${formatBiomeName(biome)}\n${kind}`;
    const iconUrl = getBiomeIconUrl(biome);
    if (iconUrl) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(heading)).setThumbnailAccessory((t) => t.setURL(iconUrl)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(heading));
    }
    divider();

    container.addTextDisplayComponents((td) => td.setContent("**Now**\nPosted the moment it's found."));
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("nowChannel", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(0)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                return now ? c.setDefaultChannels(now.channel_id) : c;
            }),
        ),
    );
    container.addActionRowComponents(
        kit.row(
            kit.roleSelect("nowRole", (r) => {
                r.setMinValues(0).setMaxValues(1).setPlaceholder("No ping");
                return now?.role_id ? r.setDefaultRoles(now.role_id) : r;
            }),
        ),
    );

    if (rare) {
        divider();
        container.addTextDisplayComponents((td) => td.setContent("**After a delay**\nA second post, later."));
        container.addActionRowComponents(
            kit.row(
                kit.channelSelect("lateChannel", (c) => {
                    c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setMinValues(0)
                        .setMaxValues(1)
                        .setPlaceholder("Pick a channel");
                    return late ? c.setDefaultChannels(late.channel_id) : c;
                }),
            ),
        );
        container.addActionRowComponents(
            kit.row(
                kit.roleSelect("lateRole", (r) => {
                    r.setMinValues(0).setMaxValues(1).setPlaceholder("No ping");
                    return late?.role_id ? r.setDefaultRoles(late.role_id) : r;
                }),
            ),
        );
        container.addActionRowComponents(
            kit.row(kit.stringSelect("lateDelay", (m) => m.setPlaceholder("Pick a delay").addOptions(delayOptions(late?.delay_s ?? null)))),
        );
    }

    const any = Boolean(now || (rare && late));
    return [
        container,
        row(
            kit.button("test", (b) => b.setLabel("Send a test").setDisabled(!any)),
            kit.button("stop", (b) => b.setLabel("Stop forwarding").setStyle(ButtonStyle.Danger).setDisabled(!any)),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

function allScreen(s: ForwardsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    const noun = TAB_NOUN[s.tab] ?? "biomes";
    const rare = s.tab === "rare";
    const count = tabBiomes(s.tab).length;
    container.addTextDisplayComponents((td) =>
        td.setContent(`## Set for all ${noun}\nApplies to all ${count}.${rare ? " Each biome keeps its own ping." : ""}`),
    );
    divider();
    container.addTextDisplayComponents((td) => td.setContent("**Now**"));
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("allNow", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(1)
                    .setMaxValues(1)
                    .setPlaceholder("Send all to…");
                return s.all.channelId ? c.setDefaultChannels(s.all.channelId) : c;
            }),
        ),
    );
    if (rare) {
        divider();
        container.addTextDisplayComponents((td) => td.setContent("**After a delay**"));
        container.addActionRowComponents(
            kit.row(
                kit.channelSelect("allLate", (c) => {
                    c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setMinValues(0)
                        .setMaxValues(1)
                        .setPlaceholder("Send all to…");
                    return s.all.lateChannelId ? c.setDefaultChannels(s.all.lateChannelId) : c;
                }),
            ),
        );
        container.addActionRowComponents(
            kit.row(kit.stringSelect("allDelay", (m) => m.setPlaceholder("Delay for all…").addOptions(delayOptions(s.all.delayS)))),
        );
    }
    const buttons = [kit.button("apply", (b) => b.setLabel("Apply").setStyle(ButtonStyle.Primary))];
    if (rare) {
        buttons.push(
            kit.button("allCopy", (b) =>
                b.setLabel("Copy Now pings to delayed").setStyle(s.all.copyPings ? ButtonStyle.Success : ButtonStyle.Secondary),
            ),
        );
    }
    buttons.push(kit.button("back", (b) => b.setLabel("Back")));
    return [container, row(...buttons)];
}

const SCREENS = { list: listScreen, editor: editorScreen, all: allScreen } as const;

export function renderForwards(s: ForwardsState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: SCREENS[s.screen](s, kit), allowedMentions: NO_PINGS };
}
