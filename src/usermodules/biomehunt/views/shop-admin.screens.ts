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
import { DURATION_PRESET_DAYS, formatSeeds, MAX_SHOP_ITEMS, SHOP_ITEMS_PER_PAGE } from "../constants/shop.constants";
import type { ShopItemRow } from "../types";
import type { ShopAdminState } from "./shop-admin.view";

export const DEFAULT_TIMED_DURATION_S = 7 * 86400;

type Parts = Array<ContainerBuilder | ActionRowBuilder<ButtonBuilder>>;

const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

function newContainer(color = 0x5865f2): { container: ContainerBuilder; divider: () => void } {
    const container = new ContainerBuilder().setAccentColor(color);
    return {
        container,
        divider: () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small)),
    };
}

export const shopItemPages = (s: Pick<ShopAdminState, "items">) => Math.max(1, Math.ceil(s.items.length / SHOP_ITEMS_PER_PAGE));

/** `7 days`, `1 day`, `12 hours`, `1 day 12 hours`. */
export function durationText(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const part = (n: number, unit: string) => (n > 0 ? [`${n} ${unit}${n === 1 ? "" : "s"}`] : []);
    return [...part(days, "day"), ...part(hours, "hour"), ...part(minutes, "minute")].join(" ");
}

/** `\`500 🌱\` · 12 left · 1 per member` - only the parts that apply. */
function numbers(item: ShopItemRow): string[] {
    return [
        ...(item.stock === null ? [] : [item.stock > 0 ? `${item.stock} left` : "Sold out"]),
        ...(item.max_per_member === null ? [] : [`${item.max_per_member} per member`]),
    ];
}

/** What the item gives, as a short phrase. */
function givesText(item: ShopItemRow): string {
    if (item.kind === "manual") return "Delivered by hand";
    const role = item.role_id ? `<@&${item.role_id}>` : "no role picked";
    return item.kind === "timed_role" && item.duration_s ? `Role ${role} for ${durationText(item.duration_s)}` : `Role ${role}`;
}

const nameLine = (item: ShopItemRow) => `${item.emoji ? `${item.emoji} ` : ""}**${item.name}**`;

const ECONOMY_OFF = [
    "```ansi",
    "\u001b[1;33m⚠ The economy is off\u001b[0m",
    "Members can't buy. Turn on EXPERIMENT_BIOME_ECONOMY in /admin flags.",
    "```",
].join("\n");

function tabsRow(s: ShopAdminState, kit: RenderKit): ActionRowBuilder<ButtonBuilder> {
    const tabs: Array<{ key: "items" | "purchases" | "settings"; label: string }> = [
        { key: "items", label: "Items" },
        { key: "purchases", label: s.pending > 0 ? `Purchases · ${s.pending}` : "Purchases" },
        { key: "settings", label: "Settings" },
    ];
    return row(
        ...tabs.map((t) =>
            kit.button(`tab:${t.key}`, (b) =>
                b
                    .setLabel(t.label)
                    .setStyle(t.key === s.screen ? ButtonStyle.Primary : ButtonStyle.Secondary)
                    .setDisabled(t.key === s.screen),
            ),
        ),
    );
}

function itemsScreen(s: ShopAdminState, kit: RenderKit): Parts {
    const { container, divider } = newContainer();
    if (!s.economyOn) {
        container.addTextDisplayComponents((td) => td.setContent(ECONOMY_OFF));
    }
    container.addSectionComponents((section) =>
        section
            .addTextDisplayComponents((td) =>
                td.setContent(s.shop.open ? "Open - members buy with `/bh shop`." : "Closed - only admins see it."),
            )
            .setButtonAccessory(
                kit.button("toggle", (b) =>
                    s.shop.open
                        ? b.setLabel("Close shop").setStyle(ButtonStyle.Danger)
                        : b.setLabel("Open shop").setStyle(ButtonStyle.Success),
                ),
            ),
    );
    divider();
    if (s.items.length === 0) container.addTextDisplayComponents((td) => td.setContent("No items yet."));
    s.items.slice(s.page * SHOP_ITEMS_PER_PAGE, (s.page + 1) * SHOP_ITEMS_PER_PAGE).forEach((item, slot, shown) => {
        const sub = [givesText(item), ...numbers(item)].join(" · ");
        container.addSectionComponents((section) =>
            section
                .addTextDisplayComponents((td) => td.setContent(`${nameLine(item)} · ${formatSeeds(item.price)}\n-# ${sub}`))
                .setButtonAccessory(kit.button(`edit:${slot}`, (b) => b.setLabel("Edit"))),
        );
        if (slot < shown.length - 1) divider();
    });
    const parts: Parts = [container, tabsRow(s, kit)];
    if (shopItemPages(s) > 1) parts.push(paginationRow(kit, s.page, shopItemPages(s)));
    parts.push(
        row(
            kit.button("add", (b) =>
                b
                    .setLabel("Add item")
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(s.items.length >= MAX_SHOP_ITEMS),
            ),
            kit.button("close", (b) => b.setLabel("Close")),
        ),
    );
    return parts;
}

const GIVES = [
    { value: "manual", label: "Nothing - delivered by hand", description: "Stays Pending until an admin marks it delivered" },
    { value: "role", label: "A role", description: "Given right away, kept for good" },
    { value: "timed_role", label: "A role for a while", description: "Given right away, removed when it runs out" },
];

function durationOptions(current: number | null) {
    const presets = DURATION_PRESET_DAYS.map((days) => ({
        label: `For ${days} ${days === 1 ? "day" : "days"}`,
        value: String(days * 86400),
        default: current === days * 86400,
    }));
    const custom =
        current !== null && !presets.some((p) => p.default)
            ? [{ label: `For ${durationText(current)}`, value: String(current), default: true }]
            : [];
    return [...presets, ...custom, { label: "Other…", value: "other", default: false }];
}

function editorScreen(s: ShopAdminState, kit: RenderKit): Parts {
    const item = s.items.find((i) => i.id === s.itemId);
    if (!item) return itemsScreen(s, kit);
    const { container, divider } = newContainer();

    const heading = `## ${item.emoji ? `${item.emoji} ` : ""}${item.name}${item.description ? `\n${item.description}` : ""}`;
    const imageUrl = item.image_url;
    if (imageUrl) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(heading)).setThumbnailAccessory((t) => t.setURL(imageUrl)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(heading));
    }
    divider();
    container.addTextDisplayComponents((td) => td.setContent([formatSeeds(item.price), ...numbers(item)].join(" · ")));
    divider();

    container.addTextDisplayComponents((td) => td.setContent("**Gives**"));
    container.addActionRowComponents(
        kit.row(
            kit.stringSelect("gives", (m) =>
                m.setPlaceholder("Pick what it gives").addOptions(GIVES.map((g) => ({ ...g, default: g.value === item.kind }))),
            ),
        ),
    );
    if (item.kind !== "manual") {
        container.addActionRowComponents(
            kit.row(
                kit.roleSelect("role", (r) => {
                    r.setMinValues(1).setMaxValues(1).setPlaceholder("Pick a role");
                    return item.role_id ? r.setDefaultRoles(item.role_id) : r;
                }),
            ),
        );
        if (s.roleIssue) container.addTextDisplayComponents((td) => td.setContent(s.roleIssue ?? ""));
    }
    if (item.kind === "timed_role") {
        container.addActionRowComponents(
            kit.row(kit.stringSelect("duration", (m) => m.setPlaceholder("Pick a duration").addOptions(durationOptions(item.duration_s)))),
        );
    }

    const index = s.items.indexOf(item);
    return [
        container,
        row(
            kit.button("details", (b) => b.setLabel("Edit details").setStyle(ButtonStyle.Primary)),
            kit.button("limits", (b) => b.setLabel("Limits")),
            kit.button("up", (b) => b.setLabel("Move up").setDisabled(index === 0)),
            kit.button("down", (b) => b.setLabel("Move down").setDisabled(index === s.items.length - 1)),
        ),
        row(
            kit.button("remove", (b) => b.setLabel("Remove").setStyle(ButtonStyle.Danger)),
            kit.button("back", (b) => b.setLabel("Back")),
        ),
    ];
}

function settingsScreen(s: ShopAdminState, kit: RenderKit): Parts {
    const { container } = newContainer();
    container.addTextDisplayComponents((td) => td.setContent("**Sales channel**\nEvery purchase is posted here."));
    container.addActionRowComponents(
        kit.row(
            kit.channelSelect("salesChannel", (c) => {
                c.setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    .setMinValues(0)
                    .setMaxValues(1)
                    .setPlaceholder("Pick a channel");
                return s.shop.sales_channel_id ? c.setDefaultChannels(s.shop.sales_channel_id) : c;
            }),
        ),
    );
    return [container, tabsRow(s, kit), row(kit.button("close", (b) => b.setLabel("Close")))];
}

const SCREENS: Partial<Record<ShopAdminState["screen"], (s: ShopAdminState, kit: RenderKit) => Parts>> = {
    items: itemsScreen,
    editor: editorScreen,
    settings: settingsScreen,
};

export function renderShopAdmin(s: ShopAdminState, kit: RenderKit): ViewRender {
    return { flags: MessageFlags.IsComponentsV2, components: (SCREENS[s.screen] ?? itemsScreen)(s, kit), allowedMentions: NO_PINGS };
}
