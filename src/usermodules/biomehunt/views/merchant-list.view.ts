import { ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { defineView, type ViewDefinition, type ViewPayload } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { getAllMerchants, getMerchant, type MerchantEntry } from "../constants/merchants.constants";
import { CLEAR_VALUE, formatHexColor } from "../services/biome-admin.service";
import {
    defaultMerchantAdminDeps,
    editMerchant,
    type MerchantAdminDeps,
    NO_MERCHANT_CHANGES,
    setMerchantActive,
} from "../services/merchant-admin.service";
import { BiomeHuntError } from "../types";

const named = (m: MerchantEntry) => `${m.emoji ? `${m.emoji} ` : ""}${m.label}`;

/** A merchant's every field, with its image as the thumbnail and its color as the accent. */
export function buildMerchantCard(m: MerchantEntry): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(m.color);
    const content = [
        `### ${named(m)}${m.enabled ? "" : " (disabled)"}`,
        `- **Color:** \`${formatHexColor(m.color)}\``,
        `- **Flavor text:** ${m.flavorText ? `*${m.flavorText}*` : "none"}`,
        `- **Image:** ${m.iconUrl ?? "none"}`,
        `- **Emoji:** ${m.emoji ?? "none"}`,
    ].join("\n");
    const iconUrl = m.iconUrl;
    if (iconUrl) {
        container.addSectionComponents((section) =>
            section.addTextDisplayComponents((td) => td.setContent(content)).setThumbnailAccessory((t) => t.setURL(iconUrl)),
        );
    } else {
        container.addTextDisplayComponents((td) => td.setContent(content));
    }
    return container;
}

function listContainer(): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    container.addTextDisplayComponents((td) => td.setContent("### Merchants"));
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    const lines = getAllMerchants().map((m) => `- ${m.enabled ? "✅" : "❌"} **${named(m)}**`);
    container.addTextDisplayComponents((td) => td.setContent(lines.join("\n") || "None registered."));
    return container;
}

interface MerchantListState {
    selected: string | null;
}

/** `/owner merchant list`: every merchant, and a card per merchant that edits it in place. */
export function merchantListView(deps: MerchantAdminDeps = defaultMerchantAdminDeps()): ViewDefinition<MerchantListState, void, void> {
    return defineView<MerchantListState, void, void>({
        name: "biomehunt.merchant-list",
        initial: () => ({ selected: null }),
        render: (state, kit): ViewPayload => {
            const selected = state.selected ? getMerchant(state.selected) : undefined;
            const components = selected
                ? [
                      buildMerchantCard(selected),
                      kit.row(
                          kit.button("edit", (b) => b.setLabel("Edit details").setStyle(ButtonStyle.Primary)),
                          kit.button("toggle", (b) =>
                              b
                                  .setLabel(selected.enabled ? "Disable" : "Enable")
                                  .setStyle(selected.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
                          ),
                          kit.button("back", (b) => b.setLabel("Back")),
                      ),
                  ]
                : [
                      listContainer(),
                      kit.row(
                          kit.stringSelect("pick", (s) =>
                              s.setPlaceholder("Pick a merchant").addOptions(
                                  getAllMerchants()
                                      .slice(0, 25)
                                      .map((m) => ({ label: m.label, value: m.key })),
                              ),
                          ),
                      ),
                  ];
            return { flags: MessageFlags.IsComponentsV2, components, allowedMentions: NO_PINGS };
        },
        on: {
            pick: (c) => {
                c.state.selected = c.values[0];
            },
            back: (c) => {
                c.state.selected = null;
            },
            toggle: async (c) => {
                const m = c.state.selected ? getMerchant(c.state.selected) : undefined;
                if (m) await setMerchantActive(m.key, !m.enabled, deps);
            },
            edit: async (c) => {
                const m = c.state.selected ? getMerchant(c.state.selected) : undefined;
                if (!m) return;
                const values = await c.modal({
                    title: `Edit ${m.label}`.slice(0, 45),
                    fields: [
                        { key: "name", label: "Display name", value: m.label, required: true, maxLength: 60 },
                        { key: "color", label: "Color (6 hex digits, no #)", value: formatHexColor(m.color), required: true, maxLength: 6 },
                        { key: "flavor", label: "Flavor text (blank = none)", value: m.flavorText, required: false },
                        { key: "icon", label: "Image URL, https:// (blank = none)", value: m.iconUrl, required: false },
                        { key: "emoji", label: "Emoji or <:name:id> (blank = none)", value: m.emoji, required: false },
                    ],
                });
                if (!values) return;
                const orClear = (v: string | undefined) => (v?.trim() ? v : CLEAR_VALUE);
                try {
                    await editMerchant(
                        m.key,
                        {
                            ...NO_MERCHANT_CHANGES,
                            name: values.name,
                            color: values.color,
                            flavorText: orClear(values.flavor),
                            iconUrl: orClear(values.icon),
                            emoji: orClear(values.emoji),
                        },
                        deps,
                    );
                } catch (err) {
                    if (!(err instanceof BiomeHuntError)) throw err;
                    await c.notify(err.message);
                }
            },
        },
    });
}
