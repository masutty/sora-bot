import { ActionRowBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { paginationRow, type RenderKit, type ViewRender } from "@/define";
import { formatTime, NO_PINGS } from "@/utils/format";
import { QUOTA_PRESETS } from "../constants/quota-presets.constants";
import { quotaDayWindow } from "../services/quota.service";
import type { QuotaRoleRow } from "../types";
import type { QuotasScreen, QuotasState } from "./quotas.view";

export const QUOTAS_PER_PAGE = 4;

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

function newContainer(color = 0x5865f2): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(color);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

export const quotaPages = (quotas: QuotaRoleRow[]) => Math.max(1, Math.ceil(quotas.length / QUOTAS_PER_PAGE));

export const daysText = (n: number) => (n === 1 ? "1 day" : `${n} days`);
/** Whole days when the hours are a round number of days, else hours. */
export const windowText = (hours: number) => (hours % 24 === 0 ? daysText(hours / 24) : `${hours}h`);

export const typeLabel = (q: QuotaRoleRow) => (q.mode === "F" ? "Daily reward" : "Live role");

/** One quota as a sentence of what members get. */
export function quotaSentence(q: QuotaRoleRow): string {
    const target = `\`${formatTime(q.quota_target_seconds)}\``;
    return q.mode === "F"
        ? `Macro ${target} in a day → keep it \`${daysText(q.access_duration_days ?? 1)}\``
        : `Have ${target} in the last \`${windowText(q.quota_window_hours)}\``;
}

const holdersText = (n: number) => `${n} ${n === 1 ? "member has" : "members have"} it`;

/** Next daily check as a Discord timestamp, shown in each viewer's own time zone. */
const nextCheck = (s: QuotasState) => `<t:${Math.floor(quotaDayWindow(s.evalHourUtc, new Date()).end.getTime() / 1000)}:t>`;

function listScreen(s: QuotasState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent("**Quotas**\nRoles members earn by macroing."));
    divider();
    if (s.quotas.length === 0) {
        container.addTextDisplayComponents((td) => td.setContent("No quotas yet."));
        divider();
    }
    s.quotas.slice(s.page * QUOTAS_PER_PAGE, (s.page + 1) * QUOTAS_PER_PAGE).forEach((q, slot) => {
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) =>
                    td.setContent(`<@&${q.role_id}> · ${typeLabel(q)}\n${quotaSentence(q)}\n-# ${holdersText(s.holders[q.role_id] ?? 0)}`),
                )
                .setButtonAccessory(kit.button(`edit:${slot}`, (b) => b.setLabel("Edit"))),
        );
        divider();
    });
    container.addTextDisplayComponents((td) => td.setContent(`-# ⏰ Daily rewards are checked every day at ${nextCheck(s)}`));
    const parts: Parts = [container];
    if (quotaPages(s.quotas) > 1) parts.push(paginationRow(kit, s.page, quotaPages(s.quotas)));
    parts.push(
        row(
            kit.button("add", (b) => b.setLabel("Add quota").setStyle(ButtonStyle.Primary)),
            kit.button("checkTime", (b) => b.setLabel("Check time")),
            kit.button("checkNow", (b) => b.setLabel("Check now")),
        ),
    );
    return parts;
}

function editorScreen(s: QuotasState, kit: RenderKit): Parts {
    const q = s.quotas.find((x) => x.role_id === s.roleId);
    if (!q) return listScreen(s, kit);
    const { container, divider } = newContainer(s.color ?? 0x5865f2);
    const target = `- Target: \`${formatTime(q.quota_target_seconds)}\` of macro time`;
    const daily = q.mode === "F";
    container.addTextDisplayComponents((td) =>
        td.setContent(`## <@&${q.role_id}>\n${typeLabel(q)} · ${daily ? `checked every day at ${nextCheck(s)}` : "checked all the time"}`),
    );
    divider();
    container.addTextDisplayComponents((td) =>
        td.setContent(
            daily
                ? `${target}\n- Role lasts: \`${daysText(q.access_duration_days ?? 1)}\` after each day they hit it`
                : `${target}\n- Counted over: \`${windowText(q.quota_window_hours)}\``,
        ),
    );
    divider();
    const holders = holdersText(s.holders[q.role_id] ?? 0);
    container.addTextDisplayComponents((td) => td.setContent(`-# ${daily ? `${holders} · ${s.hitToday} hit it today` : holders}`));
    return [
        container,
        row(
            kit.button("editNumbers", (b) => b.setLabel("Edit numbers")),
            kit.button("changeType", (b) => b.setLabel("Change type")),
            kit.button("whoHit", (b) => b.setLabel("Who hit it")),
            kit.button("delete", (b) => b.setLabel("Delete").setStyle(ButtonStyle.Danger)),
        ),
        row(kit.button("back", (b) => b.setLabel("Back"))),
    ];
}

function addRoleScreen(_s: QuotasState, kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent("**New quota**\nPick the role members will earn."));
    container.addActionRowComponents(
        kit.row(kit.roleSelect("addRole", (r) => r.setPlaceholder("Pick a role").setMinValues(1).setMaxValues(1))),
    );
    return [container, row(kit.button("back", (b) => b.setLabel("Cancel")))];
}

function addPresetScreen(s: QuotasState, kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent(`**New quota for <@&${s.roleId}>**\nStart from a preset, or build your own.`));
    container.addActionRowComponents(
        kit.row(
            kit.stringSelect("preset", (m) =>
                m
                    .setPlaceholder("Pick a preset")
                    .addOptions([
                        ...QUOTA_PRESETS.map((p) => ({ label: p.label, description: p.description, value: p.key })),
                        { label: "Custom", description: "Choose the type and numbers yourself", value: "custom" },
                    ]),
            ),
        ),
    );
    return [container, row(kit.button("back", (b) => b.setLabel("Cancel")))];
}

function addTypeScreen(s: QuotasState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    const title = s.typeFor === "add" ? `New quota for <@&${s.roleId}>` : `Change the type of <@&${s.roleId}>`;
    container.addTextDisplayComponents((td) => td.setContent(`**${title}**\nHow should members earn it?`));
    divider();
    const choice = (key: string, name: string, note: string) =>
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(`**${name}**\n-# ${note}`))
                .setButtonAccessory(kit.button(key, (b) => b.setLabel("Choose").setStyle(ButtonStyle.Primary))),
        );
    choice("type:F", "Daily reward", "Checked once a day. Hit the target, get the role for a few days.");
    divider();
    choice("type:RW", "Live role", "Checked all the time. Kept while their recent hours reach the target.");
    return [container, row(kit.button("back", (b) => b.setLabel("Cancel")))];
}

const SCREENS: Record<QuotasScreen, (s: QuotasState, kit: RenderKit) => Parts> = {
    list: listScreen,
    editor: editorScreen,
    addRole: addRoleScreen,
    addPreset: addPresetScreen,
    addType: addTypeScreen,
};

export function renderQuotas(s: QuotasState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: SCREENS[s.screen](s, kit), allowedMentions: NO_PINGS };
}
