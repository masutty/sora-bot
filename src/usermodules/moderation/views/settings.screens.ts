import { type ActionRowBuilder, type ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, MessageFlags } from "discord.js";
import { addDivider, addItems, type Item, paginationRow, type RenderKit, type ViewRender } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { thresholdAction } from "../services/ladder";
import { settings } from "../settings";
import type { SettingsState } from "./settings.view";

/** Thresholds per page - each takes a Section. */
export const THRESHOLDS_PER_PAGE = 5;

export const thresholdPageCount = (count: number) => Math.max(1, Math.ceil(count / THRESHOLDS_PER_PAGE));

const box = () => new ContainerBuilder().setAccentColor(settings.accentColor);
const wrap = (container: ContainerBuilder, ...rest: ActionRowBuilder<ButtonBuilder>[]): ViewRender => ({
    flags: MessageFlags.IsComponentsV2,
    components: [container, ...rest],
    allowedMentions: NO_PINGS,
});
const onOff = (value: boolean) => (value ? "On" : "Off");

function main(s: SettingsState, kit: RenderKit): ViewRender {
    const cfg = s.settings;
    const change = (key: string, label = "Change") => kit.button(key, (b) => b.setLabel(label));
    const toggle = (key: string, on: boolean) =>
        kit.button(key, (b) => b.setLabel(on ? "Turn off" : "Turn on").setStyle(on ? ButtonStyle.Danger : ButtonStyle.Success));
    const count = s.ladder.length;
    const thresholds = count === 0 ? "no Thresholds" : `${count} ${count === 1 ? "Threshold" : "Thresholds"}`;
    const days = cfg.warn_expiry_days;
    const roleChannelAppeal: Item[] = [
        {
            text: `**Moderator role:** ${cfg.moderator_role_id ? `<@&${cfg.moderator_role_id}>` : "none"}`,
            button: change("pickRole"),
            note: "-# Members with this role can use every moderation command, and so can admins.",
        },
        {
            text: `**Case Channel:** ${cfg.case_channel_id ? `<#${cfg.case_channel_id}>` : "none"}`,
            button: change("pickChannel"),
            note: "-# Where every new or ended case is posted.",
        },
        {
            // The line itself is quoted in full under the explanation, so it is readable as members see it.
            text: cfg.appeal_line ? "**Appeal line**" : "**Appeal line:** none",
            button: change("appeal"),
            note: `-# Shown in punishment DMs so members know where to appeal.${cfg.appeal_line ? `\n>>> ${cfg.appeal_line}` : ""}`,
        },
    ];
    const expiry: Item = {
        text: `**Warn expiry:** ${days} ${days === 1 ? "day" : "days"}`,
        button: change("expiry"),
        note: "-# How long a warn counts toward Auto-Punishment.",
    };
    const auto: Item = {
        text: `**Auto-Punishment:** ${onOff(cfg.auto_enabled)}, ${thresholds}`,
        button: toggle("auto", cfg.auto_enabled),
        note: "-# Mutes, kicks or bans a member when their active warns reach a Threshold.",
    };
    const undo: Item = {
        text: `**Auto-undo:** ${onOff(cfg.auto_undo)}`,
        button: toggle("undo", cfg.auto_undo),
        note: "-# When a warn is revoked, the punishment it caused is lifted too.",
    };
    const container = box().addTextDisplayComponents((td) => td.setContent("**Moderator settings**"));
    addDivider(container);
    const compact = { dividers: false, notesBeside: true };
    addItems(container, roleChannelAppeal, compact);
    addDivider(container);
    addItems(container, [expiry, auto], compact);
    container.addActionRowComponents(kit.row(change("ladder", "Edit Thresholds")));
    addItems(container, [undo], compact);
    return wrap(container);
}

/** The role or Case Channel picker: the existing select (empty clears) and Back. */
function pick(s: SettingsState, kit: RenderKit): ViewRender {
    const cfg = s.settings;
    const isRole = s.screen === "role";
    const select = isRole
        ? kit.roleSelect("role", (r) => {
              r.setMinValues(0).setMaxValues(1).setPlaceholder("None");
              return cfg.moderator_role_id ? r.setDefaultRoles(cfg.moderator_role_id) : r;
          })
        : kit.channelSelect("channel", (c) => {
              c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                  .setMinValues(0)
                  .setMaxValues(1)
                  .setPlaceholder("None");
              return cfg.case_channel_id ? c.setDefaultChannels(cfg.case_channel_id) : c;
          });
    return wrap(
        box()
            .addTextDisplayComponents((td) => td.setContent(isRole ? "**Moderator role**" : "**Case Channel**"))
            .addActionRowComponents(kit.row(select))
            .addActionRowComponents(kit.row(kit.button("back", (b) => b.setLabel("Back")))),
    );
}

function ladder(s: SettingsState, kit: RenderKit): ViewRender {
    const from = s.page * THRESHOLDS_PER_PAGE;
    const shown = s.ladder.slice(from, from + THRESHOLDS_PER_PAGE);
    const container = box().addTextDisplayComponents((td) =>
        td.setContent(shown.length === 0 ? "**Thresholds**\nNo Thresholds." : "**Thresholds**"),
    );
    if (shown.length > 0) {
        addDivider(container);
        addItems(
            container,
            shown.map((t, i) => ({
                text: `**${t.warns} ${t.warns === 1 ? "warn" : "warns"}:** ${thresholdAction(t)}`,
                button: kit.button(`edit:${i}`, (b) => b.setLabel("Edit")),
            })),
            { dividers: false },
        );
        addDivider(container);
    }
    container.addActionRowComponents(
        kit.row(
            kit.button("add", (b) => b.setLabel("Add").setStyle(ButtonStyle.Success)),
            kit.button("example", (b) => b.setLabel("Use example")),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    );
    const pages = thresholdPageCount(s.ladder.length);
    return pages > 1 ? wrap(container, paginationRow(kit, s.page, pages)) : wrap(container);
}

export function renderSettings(s: SettingsState, kit: RenderKit): ViewRender {
    if (s.screen === "ladder") return ladder(s, kit);
    if (s.screen === "role" || s.screen === "channel") return pick(s, kit);
    return main(s, kit);
}
