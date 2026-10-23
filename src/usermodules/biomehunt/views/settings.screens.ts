import {
    ActionRowBuilder,
    type ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ContainerBuilder,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import type { RenderKit, ViewRender } from "@/define";
import { formatTime, NO_PINGS } from "@/utils/format";
import type { ActivityStatus } from "../types";
import type { Screen, SettingsState } from "./settings.view";

export const STATUSES: Array<{ status: ActivityStatus; emoji: string; label: string }> = [
    { status: "active", emoji: "🟢", label: "Active" },
    { status: "idle", emoji: "🟡", label: "Idle" },
    { status: "inactive", emoji: "🔴", label: "Inactive" },
];

/** The not-ready banner: yellow title, red line, so it can't be missed. */
const NOT_READY_BLOCK =
    "```ansi\n\u001b[1;33m ⚠ NOT READY YET \u001b[0m\n\u001b[31mMembers can't run /bh setup until this is set.\u001b[0m\n```";

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

const isReady = (s: SettingsState) => s.categoryIds.length > 0;
const roleText = (id: string | null) => (id ? `<@&${id}>` : "no role");

function newContainer(): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

function backRow(kit: RenderKit, key = "back"): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(kit.button(key, (b) => b.setLabel("Back")));
}

/** One line: bold title, the value text under it, and an accessory button. */
function addSetting(container: ContainerBuilder, title: string, value: string, button: ButtonBuilder): void {
    container.addSectionComponents((section) =>
        section.addTextDisplayComponents((td) => td.setContent(`**${title}**\n${value}`)).setButtonAccessory(button),
    );
}

function autoDeleteSummary(s: SettingsState): string {
    const after = `\`${formatHours(s.deleteAfterS)}\``;
    return s.autoDelete
        ? `On · removes a channel ${after} after its member goes inactive.`
        : `Off · would remove a channel ${after} after its member goes inactive.`;
}

function whatItDoes(s: SettingsState): string {
    return s.clearProfileOnAutoDelete
        ? "Deletes everything: removes their whole profile."
        : "Unlinks them: removes the channel, keeps their data, gives the Deleted?! badge.";
}

function notReadyScreen(kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent("**Server settings**"));
    container.addTextDisplayComponents((td) => td.setContent(NOT_READY_BLOCK));
    divider();
    addSetting(
        container,
        "Macro channels",
        "No category picked.",
        kit.button("edit:channels", (b) => b.setLabel("Set up").setStyle(ButtonStyle.Primary)),
    );
    divider();
    container.addTextDisplayComponents((td) => td.setContent("-# Everything else has a working default."));
    return [
        container,
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            kit.button("showAll", (b) => b.setLabel("Show all settings")),
            kit.button("close", (b) => b.setLabel("Close")),
        ),
    ];
}

function overviewScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    const edit = (key: string) => kit.button(key, (b) => b.setLabel("Edit"));
    const full = s.categoryIds.length > 1 ? "they are full" : "it is full";
    const categories = s.categoryIds.length > 0 ? s.categoryIds.map((id) => `<#${id}>`).join(", ") : "none";

    container.addTextDisplayComponents((td) => td.setContent("**Server settings**\nHow macro activity is tracked on this server."));
    divider();
    addSetting(
        container,
        "Activity",
        `A session ends \`${formatTime(s.gapS)}\` after the last macro message. Idle \`${formatTime(s.idleS)}\` after a session ends, inactive after \`${formatHours(s.inactiveS)}\`.`,
        edit("edit:activity"),
    );
    divider();
    addSetting(container, "Status roles", STATUSES.map((x) => `${x.emoji} ${roleText(s.roles[x.status])}`).join(" · "), edit("edit:roles"));
    divider();
    addSetting(
        container,
        "Macro channels",
        `New channels go in ${categories}. ${s.autoCreateCategories ? `A new category is made when ${full}.` : `No new category is made when ${full}.`}`,
        edit("edit:channels"),
    );
    divider();
    addSetting(container, "Auto-delete", autoDeleteSummary(s), edit("edit:autodelete"));
    divider();
    addSetting(container, "Live counter", s.counterChannelId ? `In <#${s.counterChannelId}>` : "Off", edit("edit:counter"));
    divider();
    addSetting(container, "Log channel", s.logChannelId ? `Problems are posted in <#${s.logChannelId}>.` : "Off", edit("edit:logs"));
    return [
        container,
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            kit.button("reset", (b) => b.setLabel("Reset all").setStyle(ButtonStyle.Danger)),
            kit.button("close", (b) => b.setLabel("Close")),
        ),
    ];
}

function rolesScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) =>
        td.setContent(
            "## Status roles\nOptional. Pick a role for each status you want to mark - only Active, only Idle, all three, any mix. A status left empty gives no role.",
        ),
    );
    divider();
    for (const { status, emoji, label } of STATUSES) {
        container.addTextDisplayComponents((td) => td.setContent(`**${emoji} ${label}**`));
        container.addActionRowComponents(
            kit.row(
                kit.roleSelect(`role:${status}`, (r) => {
                    r.setMinValues(0)
                        .setMaxValues(1)
                        .setPlaceholder(status === "inactive" ? "No role" : label);
                    const current = s.roles[status];
                    return current ? r.setDefaultRoles(current) : r;
                }),
            ),
        );
    }
    return [container, backRow(kit)];
}

function channelsScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) =>
        td.setContent("## Macro channels\nCategories new macro channels go into. Each one holds 50 channels."),
    );
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("categories", (c) => {
                c.setChannelTypes(ChannelType.GuildCategory).setMinValues(1).setMaxValues(25).setPlaceholder("Pick categories");
                return s.categoryIds.length > 0 ? c.setDefaultChannels(...s.categoryIds.slice(0, 25)) : c;
            }),
        ),
    );
    divider();
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) =>
                td.setContent(
                    "**New category when all are full**\nMakes a new category and keeps going. Off: setup fails until an admin adds room.",
                ),
            )
            .setButtonAccessory(
                kit.button("autocreate", (b) =>
                    b
                        .setLabel(s.autoCreateCategories ? "Turn off" : "Turn on")
                        .setStyle(s.autoCreateCategories ? ButtonStyle.Danger : ButtonStyle.Success),
                ),
            ),
    );
    return [container, backRow(kit)];
}

function autoDeleteScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent("## Auto-delete"));
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) => td.setContent(`**Auto-delete inactive members**\n${s.autoDelete ? "On" : "Off"}`))
            .setButtonAccessory(
                kit.button("ad:toggle", (b) =>
                    b.setLabel(s.autoDelete ? "Turn off" : "Turn on").setStyle(s.autoDelete ? ButtonStyle.Danger : ButtonStyle.Success),
                ),
            ),
    );
    container.addTextDisplayComponents((td) => td.setContent("-# Paused members are never auto-deleted."));
    divider();
    addSetting(
        container,
        "After",
        `\`${formatHours(s.deleteAfterS)}\` inactive`,
        kit.button("ad:after", (b) => b.setLabel("Change")),
    );
    divider();
    addSetting(
        container,
        "What it does",
        whatItDoes(s),
        kit.button("ad:what", (b) => b.setLabel("Change")),
    );
    return [container, backRow(kit)];
}

function autoDeleteWhatScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    const choice = (key: string, title: string, text: string, chosen: boolean) =>
        addSetting(
            container,
            title,
            text,
            kit.button(key, (b) =>
                b
                    .setLabel(chosen ? "Chosen" : "Choose")
                    .setStyle(chosen ? ButtonStyle.Secondary : ButtonStyle.Primary)
                    .setDisabled(chosen),
            ),
        );
    container.addTextDisplayComponents((td) => td.setContent("**What should auto-delete do?**"));
    divider();
    choice("what:unlink", "Unlink", "Removes the channel. Keeps their data. Gives the Deleted?! badge.", !s.clearProfileOnAutoDelete);
    divider();
    choice("what:wipe", "Delete everything", "Removes their whole profile.", s.clearProfileOnAutoDelete);
    return [container, backRow(kit, "back:autodelete")];
}

function counterScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) =>
        td.setContent(
            "## Live counter\nA message that shows how many members are active, idle and inactive, kept up to date. Clear the select to turn it off.",
        ),
    );
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("counter", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(0)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                return s.counterChannelId ? c.setDefaultChannels(s.counterChannelId) : c;
            }),
        ),
    );
    divider();
    container.addTextDisplayComponents((td) => td.setContent("-# Preview"));
    const n = s.counts ?? { active: 0, idle: 0, inactive: 0 };
    container.addTextDisplayComponents((td) =>
        td.setContent(
            [
                "**Macro Activity Counter**",
                `- 🟢 Active: \`${n.active}\``,
                `- 🟡 Idle: \`${n.idle}\``,
                `- 🔴 Inactive: \`${n.inactive}\``,
            ].join("\n"),
        ),
    );
    return [
        container,
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            kit.button("refresh", (b) => b.setLabel("Refresh now")),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

function logsScreen(s: SettingsState, kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addTextDisplayComponents((td) =>
        td.setContent(
            "## Log channel\nWhere the bot posts what went wrong on this server, and every fake find. Clear the select to turn it off.",
        ),
    );
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("logs", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(0)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                return s.logChannelId ? c.setDefaultChannels(s.logChannelId) : c;
            }),
        ),
    );
    return [
        container,
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            kit.button("logs:test", (b) => b.setLabel("Send a test")),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

function homeScreen(s: SettingsState, kit: RenderKit): Parts {
    return isReady(s) || s.showAll ? overviewScreen(s, kit) : notReadyScreen(kit);
}

const SCREENS: Record<Screen, (s: SettingsState, kit: RenderKit) => Parts> = {
    home: homeScreen,
    roles: rolesScreen,
    channels: channelsScreen,
    autodelete: autoDeleteScreen,
    autodeleteWhat: autoDeleteWhatScreen,
    counter: counterScreen,
    logs: logsScreen,
};

/** The whole message for the screen the state is on. */
export function renderSettings(s: SettingsState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: SCREENS[s.screen](s, kit), allowedMentions: NO_PINGS };
}

/** Whole hours (`72h`) when the seconds are a round number of hours, else the usual `1h 30m`. */
export function formatHours(seconds: number): string {
    return seconds % 3600 === 0 ? `${seconds / 3600}h` : formatTime(seconds);
}
