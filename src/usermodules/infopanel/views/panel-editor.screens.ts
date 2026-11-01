import {
    ActionRowBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { type AnySelect, paginationRow, type RenderKit, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { imageCount, pageChars } from "../services/input";
import { settings } from "../settings";
import type { Block, OptionRow, PanelRow } from "../types";
import { buildPreview } from "./panel.render";

export type EditorScreen = "panels" | "page" | "options" | "publish";

export interface EditorState {
    screen: EditorScreen;
    /** Page of the Panels or Options list. */
    page: number;
    panels: PanelRow[];
    panelId: number | null;
    options: OptionRow[];
    /** The option whose page is open; null is the panel's root page. */
    optionId: number | null;
    /** The block picked in the Block select. */
    blockIndex: number;
    /** The channel picked on the Publish screen. */
    channelId: string | null;
}

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<ButtonBuilder | AnySelect>>;

const CONTROLS_COLOR = 0x4e5058;
const NEAR_LIMIT = 0.8;

export const currentPanel = (s: EditorState) => s.panels.find((m) => m.id === s.panelId) ?? null;
export const currentOption = (s: EditorState) => (s.optionId === null ? null : (s.options.find((o) => o.id === s.optionId) ?? null));
export const currentBlocks = (s: EditorState): Block[] => (currentOption(s) ?? currentPanel(s))?.blocks ?? [];

export const listPages = (count: number) => Math.max(1, Math.ceil(count / settings.listPerPage));

const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

const divider = (c: ContainerBuilder) => c.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

const accent = (color: number = settings.accentColor) => new ContainerBuilder().setAccentColor(color);

/** `Title: General rules` - what the Block select shows for one block. */
export function blockLabel(block: Block, index: number): string {
    const text =
        block.t === "sep"
            ? "Separator"
            : block.t === "img"
              ? "Image"
              : `${block.t === "title" ? "Title" : "Text"}: ${block.v.replace(/\s+/g, " ")}`;
    return `${index + 1} · ${text}`.slice(0, 100);
}

function panelsScreen(s: EditorState, kit: RenderKit): Parts {
    const container = accent();
    if (s.panels.length === 0) container.addTextDisplayComponents((td) => td.setContent("No panels yet."));
    const shown = s.panels.slice(s.page * settings.listPerPage, (s.page + 1) * settings.listPerPage);
    shown.forEach((panel, slot) => {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) =>
                    td.setContent(`**${panel.name}**\n-# ${panel.channel_id ? `<#${panel.channel_id}>` : "Not posted"}`),
                )
                .setButtonAccessory(kit.button(`open:${slot}`, (b) => b.setLabel("Edit"))),
        );
        if (slot < shown.length - 1) divider(container);
    });
    const parts: Parts = [container];
    if (listPages(s.panels.length) > 1) parts.push(paginationRow(kit, s.page, listPages(s.panels.length)));
    parts.push(
        row(
            kit.button("addPanel", (b) =>
                b
                    .setLabel("Add panel")
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(s.panels.length >= settings.maxPanelsPerGuild),
            ),
            kit.button("close", (b) => b.setLabel("Close")),
        ),
    );
    return parts;
}

function controls(s: EditorState, kit: RenderKit): ContainerBuilder {
    const blocks = currentBlocks(s);
    const container = accent(CONTROLS_COLOR);
    container.addTextDisplayComponents((td) => td.setContent("**Editing**"));
    container.addActionRowComponents(
        kit.row(
            kit.stringSelect("target", (m) =>
                m.addOptions(
                    { label: "Root", value: "root", default: s.optionId === null },
                    ...s.options.map((o) => ({ label: o.label, value: String(o.id), default: o.id === s.optionId })),
                ),
            ),
        ),
    );
    if (blocks.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("**Block**\nNo blocks yet."));
    } else {
        container.addTextDisplayComponents((td) => td.setContent("**Block**"));
        container.addActionRowComponents(
            kit.row(
                kit.stringSelect("block", (m) =>
                    m.addOptions(blocks.map((b, i) => ({ label: blockLabel(b, i), value: String(i), default: i === s.blockIndex }))),
                ),
            ),
        );
        const picked = blocks[s.blockIndex];
        container.addActionRowComponents(
            row(
                kit.button("blockEdit", (b) => b.setLabel("Edit").setDisabled(!picked || picked.t === "sep")),
                kit.button("blockUp", (b) => b.setLabel("Move up").setDisabled(s.blockIndex === 0)),
                kit.button("blockDown", (b) => b.setLabel("Move down").setDisabled(s.blockIndex >= blocks.length - 1)),
                kit.button("blockRemove", (b) => b.setLabel("Remove").setStyle(ButtonStyle.Danger)),
            ),
        );
    }
    const chars = pageChars(blocks);
    if (chars >= settings.maxPageChars * NEAR_LIMIT) {
        container.addTextDisplayComponents((td) => td.setContent(`-# Text ${chars}/${settings.maxPageChars}`));
    }
    return container;
}

function pageScreen(s: EditorState, kit: RenderKit): Parts {
    const panel = currentPanel(s);
    if (!panel) return panelsScreen(s, kit);
    const option = currentOption(s);
    const blocks = currentBlocks(s);
    const full = blocks.length >= settings.maxBlocks;
    const preview = buildPreview(panel, s.options, option).components[0];

    const add = row(
        kit.button("addTitle", (b) => b.setLabel("Add title").setStyle(ButtonStyle.Success).setDisabled(full)),
        kit.button("addText", (b) => b.setLabel("Add text").setStyle(ButtonStyle.Success).setDisabled(full)),
        kit.button("addImage", (b) =>
            b
                .setLabel("Add image")
                .setStyle(ButtonStyle.Success)
                .setDisabled(full || imageCount(blocks) >= settings.maxImages),
        ),
        kit.button("addSep", (b) => b.setLabel("Add separator").setStyle(ButtonStyle.Success).setDisabled(full)),
    );
    const index = option ? s.options.indexOf(option) : -1;
    const nav = option
        ? row(
              kit.button("rename", (b) => b.setLabel("Rename")),
              kit.button("optionUp", (b) => b.setLabel("Option up").setDisabled(index <= 0)),
              kit.button("optionDown", (b) => b.setLabel("Option down").setDisabled(index >= s.options.length - 1)),
              kit.button("deleteOption", (b) => b.setLabel("Delete option").setStyle(ButtonStyle.Danger)),
              kit.button("back", (b) => b.setLabel("Back")),
          )
        : row(
              kit.button("rename", (b) => b.setLabel("Rename")),
              kit.button("options", (b) => b.setLabel("Options").setStyle(ButtonStyle.Primary)),
              kit.button("publish", (b) => b.setLabel("Publish").setStyle(ButtonStyle.Primary)),
              kit.button("deletePanel", (b) => b.setLabel("Delete panel").setStyle(ButtonStyle.Danger)),
              kit.button("back", (b) => b.setLabel("Back")),
          );
    return [preview, controls(s, kit), add, nav];
}

function optionsScreen(s: EditorState, kit: RenderKit): Parts {
    const container = accent();
    container.addTextDisplayComponents((td) => td.setContent("**Options**"));
    divider(container);
    if (s.options.length === 0) container.addTextDisplayComponents((td) => td.setContent("No options yet."));
    const shown = s.options.slice(s.page * settings.listPerPage, (s.page + 1) * settings.listPerPage);
    shown.forEach((o, slot) => {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) =>
                    td.setContent(`${o.emoji ? `${o.emoji} ` : ""}**${o.label}**${o.description ? `\n-# ${o.description}` : ""}`),
                )
                .setButtonAccessory(kit.button(`edit:${slot}`, (b) => b.setLabel("Edit"))),
        );
        if (slot < shown.length - 1) divider(container);
    });
    const parts: Parts = [container];
    if (listPages(s.options.length) > 1) parts.push(paginationRow(kit, s.page, listPages(s.options.length)));
    parts.push(
        row(
            kit.button("addOption", (b) =>
                b
                    .setLabel("Add option")
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(s.options.length >= settings.maxOptions),
            ),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    );
    return parts;
}

function publishScreen(s: EditorState, kit: RenderKit): Parts {
    const panel = currentPanel(s);
    const container = accent();
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("channel", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(1)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                const picked = s.channelId ?? panel?.channel_id;
                return picked ? c.setDefaultChannels(picked) : c;
            }),
        ),
    );
    return [
        container,
        row(
            kit.button("post", (b) =>
                b
                    .setLabel("Publish")
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(!(s.channelId ?? panel?.channel_id)),
            ),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

const SCREENS: Record<EditorScreen, (s: EditorState, kit: RenderKit) => Parts> = {
    panels: panelsScreen,
    page: pageScreen,
    options: optionsScreen,
    publish: publishScreen,
};

export function renderEditor(s: EditorState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: SCREENS[s.screen](s, kit), allowedMentions: NO_PINGS };
}
