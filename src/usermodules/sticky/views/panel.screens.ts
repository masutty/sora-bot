import { ButtonStyle, ChannelType, ContainerBuilder, MessageFlags } from "discord.js";
import type { RenderKit, ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { delayLabel, modeLabel, settings } from "../settings";
import type { StickyRow } from "../types";
import type { PanelState } from "./panel.view";

const MAX_LIST = 25;
const PREVIEW_MAX = 500;

const box = () => new ContainerBuilder().setAccentColor(settings.accentColor);

const line = (s: StickyRow) => `<#${s.channel_id}> · ${modeLabel(s.mode)} · ${delayLabel(s.delay_seconds)}`;

const preview = (content: string) => (content.length > PREVIEW_MAX ? `${content.slice(0, PREVIEW_MAX - 1)}…` : content);

function wrap(container: ContainerBuilder, acceptText = false): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS, acceptText };
}

/** The list screen's text: used/limit header and one line per sticky. */
export function listText(overview: PanelState["overview"]): string {
    const { stickies, used, limit } = overview;
    const shown = stickies.slice(0, MAX_LIST);
    return [`**Stickies · ${used}/${limit}**`, ...(shown.length === 0 ? ["No stickies yet."] : shown.map(line))].join("\n");
}

function list(s: PanelState, kit: RenderKit): ViewRender {
    const { stickies, used, limit } = s.overview;
    const shown = stickies.slice(0, MAX_LIST);
    const container = box().addTextDisplayComponents((td) => td.setContent(listText(s.overview)));
    if (shown.length > 0) {
        container.addActionRowComponents(
            kit.row(
                kit.stringSelect("pick", (m) =>
                    m
                        .setPlaceholder("Pick a sticky")
                        .addOptions(shown.map((x) => ({ label: `#${s.names[x.channel_id] ?? x.channel_id}`, value: x.channel_id }))),
                ),
            ),
        );
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
    return wrap(container);
}

function detail(kit: RenderKit, sticky: StickyRow): ViewRender {
    const container = box()
        .addActionRowComponents(kit.row(kit.button("back", (b) => b.setLabel("← back").setStyle(ButtonStyle.Secondary))))
        .addTextDisplayComponents((td) => td.setContent(`**Sticky · <#${sticky.channel_id}>**\n${preview(sticky.content)}`))
        .addActionRowComponents(
            kit.row(
                kit.stringSelect("mode", (m) =>
                    m.addOptions(settings.modes.map((mode) => ({ label: modeLabel(mode), value: mode, default: mode === sticky.mode }))),
                ),
            ),
        )
        .addActionRowComponents(
            kit.row(
                kit.stringSelect("delay", (m) =>
                    m.addOptions(
                        settings.delaysSeconds.map((sec) => ({
                            label: delayLabel(sec),
                            value: String(sec),
                            default: sec === sticky.delay_seconds,
                        })),
                    ),
                ),
            ),
        )
        .addActionRowComponents(
            kit.row(
                kit.button("editContent", (b) => b.setLabel("Edit").setStyle(ButtonStyle.Primary)),
                kit.button("delete", (b) => b.setLabel("Delete").setStyle(ButtonStyle.Danger)),
            ),
        );
    return wrap(container);
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
    return wrap(container, true);
}

export function renderPanel(s: PanelState, kit: RenderKit): ViewRender {
    if (s.screen === "pickChannel") return pickChannel(s, kit);
    if (s.screen === "capture") return capture(s, kit);
    if (s.screen === "detail") {
        const sticky = s.overview.stickies.find((x) => x.channel_id === s.channelId);
        if (sticky) return detail(kit, sticky);
    }
    return list(s, kit);
}
