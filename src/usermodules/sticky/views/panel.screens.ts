import { type ActionRowBuilder, type ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, MessageFlags } from "discord.js";
import { addDivider, addItems, paginationRow, type RenderKit, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { delayLabel, modeLabel, settings } from "../settings";
import type { StickyRow } from "../types";
import type { PanelState } from "./panel.view";

const MAX_LIST = 25;
/** Stickies per page - each takes a Section. */
export const STICKIES_PER_PAGE = 5;
const PREVIEW_MAX = 500;

const box = () => new ContainerBuilder().setAccentColor(settings.accentColor);

const line = (s: StickyRow) => `- <#${s.channel_id}>\n> ${modeLabel(s.mode)}, ${delayLabel(s.delay_seconds)}`;

const preview = (content: string) => (content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX - 1)}…` : content);

function wrap(container: ContainerBuilder, rows: ActionRowBuilder<ButtonBuilder>[] = [], acceptText = false): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: [container, ...rows], allowedMentions: NO_PINGS, acceptText };
}

/** The plain list of stickies: used/limit header and one line per sticky (the `/sticky list` reply). */
export function listText(overview: PanelState["overview"]): string {
    const { stickies, used, limit } = overview;
    const shown = stickies.slice(0, MAX_LIST);
    return [`**Stickies (${used}/${limit})**`, ...(shown.length === 0 ? ["No stickies yet."] : shown.map(line))].join("\n");
}

export const pageCount = (count: number) => Math.max(1, Math.ceil(count / STICKIES_PER_PAGE));

function list(s: PanelState, kit: RenderKit): ViewRender {
    const { stickies, used, limit } = s.overview;
    const from = s.page * STICKIES_PER_PAGE;
    const shown = stickies.slice(from, from + STICKIES_PER_PAGE);
    const container = box().addTextDisplayComponents((td) =>
        td.setContent(shown.length === 0 ? `**Stickies (${used}/${limit})**\nNo stickies yet.` : `**Stickies (${used}/${limit})**`),
    );
    if (shown.length > 0) {
        addDivider(container);
        addItems(
            container,
            shown.map((x, i) => ({
                text: `**<#${x.channel_id}>:** ${modeLabel(x.mode)}, ${delayLabel(x.delay_seconds)}`,
                button: kit.button(`open:${i}`, (b) => b.setLabel("Open")),
            })),
            { dividers: false },
        );
        addDivider(container);
    }
    container.addActionRowComponents(
        kit.row(
            kit.button("create", (b) =>
                b
                    .setLabel("Create")
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(used >= limit),
            ),
        ),
    );
    const pages = pageCount(stickies.length);
    return pages > 1 ? wrap(container, [paginationRow(kit, s.page, pages)]) : wrap(container);
}

function detail(kit: RenderKit, sticky: StickyRow): ViewRender {
    const container = box().addTextDisplayComponents((td) => td.setContent(`**<#${sticky.channel_id}>**`));
    addDivider(container);
    addItems(
        container,
        [
            { text: `**Mode:** ${modeLabel(sticky.mode)}`, button: kit.button("changeMode", (b) => b.setLabel("Change")) },
            { text: `**Delay:** ${delayLabel(sticky.delay_seconds)}`, button: kit.button("changeDelay", (b) => b.setLabel("Change")) },
            { text: "**Content**", button: kit.button("editContent", (b) => b.setLabel("Edit")), note: preview(sticky.content) },
        ],
        { dividers: false },
    );
    addDivider(container);
    container.addActionRowComponents(
        kit.row(
            kit.button("back", (b) => b.setLabel("Back")),
            kit.button("delete", (b) => b.setLabel("Delete").setStyle(ButtonStyle.Danger)),
        ),
    );
    return wrap(container);
}

/** The Mode or Delay picker: the existing select and Back to the sticky. */
function choose(s: PanelState, kit: RenderKit, sticky: StickyRow): ViewRender {
    const isMode = s.screen === "mode";
    const select = isMode
        ? kit.stringSelect("mode", (m) =>
              m.addOptions(settings.modes.map((mode) => ({ label: modeLabel(mode), value: mode, default: mode === sticky.mode }))),
          )
        : kit.stringSelect("delay", (m) =>
              m.addOptions(
                  settings.delaysSeconds.map((sec) => ({
                      label: delayLabel(sec),
                      value: String(sec),
                      default: sec === sticky.delay_seconds,
                  })),
              ),
          );
    return wrap(
        box()
            .addTextDisplayComponents((td) => td.setContent(`**${isMode ? "Mode" : "Delay"}**`))
            .addActionRowComponents(kit.row(select))
            .addActionRowComponents(kit.row(kit.button("detail", (b) => b.setLabel("Back")))),
    );
}

function pickChannel(s: PanelState, kit: RenderKit): ViewRender {
    const container = box()
        .addActionRowComponents(kit.row(kit.button("back", (b) => b.setLabel("← back").setStyle(ButtonStyle.Secondary))))
        .addTextDisplayComponents((td) => td.setContent(s.eligible?.length === 0 ? "No channels available." : "**Pick a channel**"));
    if (s.eligible === null) {
        container.addActionRowComponents(
            kit.row(
                kit.channelSelect("channel", (c) =>
                    c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setPlaceholder("Pick a channel"),
                ),
            ),
        );
    } else if (s.eligible.length > 0) {
        const options = s.eligible.map((ch) => ({ label: `#${ch.name}`.slice(0, 100), value: ch.id }));
        container.addActionRowComponents(
            kit.row(kit.stringSelect("channel", (m) => m.setPlaceholder("Pick a channel").addOptions(options))),
        );
    }
    return wrap(container);
}

function capture(s: PanelState, kit: RenderKit): ViewRender {
    const container = box()
        .addTextDisplayComponents((td) => td.setContent(`Send the sticky for <#${s.channelId}>.`))
        .addActionRowComponents(kit.row(kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Secondary))));
    return wrap(container, [], true);
}

export function renderPanel(s: PanelState, kit: RenderKit): ViewRender {
    if (s.screen === "pickChannel") return pickChannel(s, kit);
    if (s.screen === "capture") return capture(s, kit);
    if (s.screen === "detail" || s.screen === "mode" || s.screen === "delay") {
        const sticky = s.overview.stickies.find((x) => x.channel_id === s.channelId);
        if (sticky) return s.screen === "detail" ? detail(kit, sticky) : choose(s, kit, sticky);
    }
    return list(s, kit);
}
