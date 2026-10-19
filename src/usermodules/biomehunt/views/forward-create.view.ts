import { ButtonStyle, ChannelType, ContainerBuilder, MessageFlags } from "discord.js";
import { defineView, type ViewDefinition, type ViewPayload } from "@/define";
import { NO_PINGS } from "@/utils/format";
import {
    ALL_BIOME_CATEGORIES,
    BIOME_CATEGORY_LABELS,
    formatBiomeName,
    getBiomesByCategory,
    MAX_DISCORD_CHOICES,
} from "../constants/biomes.constants";
import { settings } from "../settings";
import type { BiomeCategory } from "../types";
import type { ForwardListVariant } from "./forward-list.view";

export interface CreatedForward {
    biome: string;
    channelId: string;
    roleId: string | null;
    /** Only set by the "delayed" variant. */
    delayS?: number;
}

interface CreateForwardState {
    /** The first select's pick - `ALL`, or the category whose biomes the second select lists. */
    group?: "ALL" | BiomeCategory;
    /** A `resolveBiomeSelector` selector: `ALL`, `CAT:<category>` or one biome key. */
    biome?: string;
    channelId?: string;
    roleId?: string;
    delayS?: number;
}

/** Second-select value meaning "the whole category" instead of one biome. */
const WHOLE_CATEGORY = "__category";

/**
 * Single screen with a biome group select (All, or a category) followed by a select of that
 * category's biomes - two selects so none passes Discord's 25 options however many biomes are
 * registered - a channel select, and an optional role select (plus a delay select for the
 * "delayed" variant), confirmed with a button - `biomehunt.forward-create`, a child of
 * `biomehunt.forward-list`'s "Create". Resolves the forward to create, or `undefined` on Cancel.
 */
export function forwardCreateView(
    variant: ForwardListVariant = "live",
): ViewDefinition<CreateForwardState, CreatedForward | undefined, void> {
    const delayed = variant === "delayed";
    const isComplete = (state: CreateForwardState) => Boolean(state.biome && state.channelId && (!delayed || state.delayS !== undefined));

    return defineView<CreateForwardState, CreatedForward | undefined, void>({
        name: delayed ? "biomehunt.delayed-forward-create" : "biomehunt.forward-create",
        // Delayed forwards only exist on rare biomes, so that variant is pinned to the rare category.
        initial: () => (delayed ? { group: "rare" } : {}),
        render: (state, kit): ViewPayload => {
            const groupMenu = delayed
                ? null
                : kit.stringSelect("group", (s) =>
                      s.setPlaceholder("Select biomes").addOptions(
                          { label: "All biomes", value: "ALL", default: state.group === "ALL" },
                          ...ALL_BIOME_CATEGORIES.map((c) => ({
                              label: BIOME_CATEGORY_LABELS[c],
                              value: c,
                              default: state.group === c,
                          })),
                      ),
                  );
            const category = state.group && state.group !== "ALL" ? state.group : null;
            // One slot goes to "All <category>", so a category lists at most 24 single biomes.
            const biomeMenu = category
                ? kit.stringSelect("biome", (s) =>
                      s.setPlaceholder(`Select ${BIOME_CATEGORY_LABELS[category]} biome`).addOptions(
                          {
                              label: `All ${BIOME_CATEGORY_LABELS[category]}`,
                              value: WHOLE_CATEGORY,
                              default: state.biome === `CAT:${category}`,
                          },
                          ...getBiomesByCategory(category)
                              .slice(0, MAX_DISCORD_CHOICES - 1)
                              .map((b) => ({ label: formatBiomeName(b), value: b, default: state.biome === b })),
                      ),
                  )
                : null;
            const channelMenu = kit.channelSelect("channel", (s) => {
                s.setPlaceholder("Select destination channel").setChannelTypes(ChannelType.GuildText);
                if (state.channelId) s.setDefaultChannels(state.channelId);
                return s;
            });
            const roleMenu = kit.roleSelect("role", (s) => {
                s.setPlaceholder("Select role to ping (optional)");
                if (state.roleId) s.setDefaultRoles(state.roleId);
                return s;
            });
            const delayMenu = kit.stringSelect("delay", (s) =>
                s.setPlaceholder("Select delay").addOptions(
                    settings.delayedForward.delayChoicesS.map((d) => ({
                        label: `${d} seconds`,
                        value: String(d),
                        default: d === state.delayS,
                    })),
                ),
            );

            const container = new ContainerBuilder().setAccentColor(0x5865f2);
            container.addTextDisplayComponents((td) =>
                td.setContent(
                    delayed
                        ? "**Create Delayed Biome Forward**\nPick a biome (or a whole category, or All), a destination channel, a delay, and optionally a role to ping. Role is optional."
                        : "**Create Biome Forward**\nPick a biome (or a whole category, or All), a destination channel, and optionally a role to ping. Role is optional.",
                ),
            );

            return {
                flags: MessageFlags.IsComponentsV2,
                components: [
                    container,
                    ...(groupMenu ? [kit.row(groupMenu)] : []),
                    ...(biomeMenu ? [kit.row(biomeMenu)] : []),
                    kit.row(channelMenu),
                    ...(delayed ? [kit.row(delayMenu)] : []),
                    kit.row(roleMenu),
                    kit.row(
                        kit.button("confirm", (b) => b.setLabel("Confirm").setStyle(ButtonStyle.Success).setDisabled(!isComplete(state))),
                        kit.button("cancel", (b) => b.setLabel("Cancel").setStyle(ButtonStyle.Danger)),
                    ),
                ],
                allowedMentions: NO_PINGS,
            };
        },
        on: {
            group: (c) => {
                const group = c.values[0] as "ALL" | BiomeCategory;
                c.state.group = group;
                c.state.biome = group === "ALL" ? "ALL" : undefined;
            },
            biome: (c) => {
                const value = c.values[0];
                c.state.biome = value === WHOLE_CATEGORY ? `CAT:${c.state.group}` : value;
            },
            channel: (c) => {
                c.state.channelId = c.values[0];
            },
            role: (c) => {
                c.state.roleId = c.values[0];
            },
            delay: (c) => {
                c.state.delayS = Number(c.values[0]);
            },
            confirm: (c) => {
                if (!isComplete(c.state) || !c.state.biome || !c.state.channelId) return;
                c.done({ biome: c.state.biome, channelId: c.state.channelId, roleId: c.state.roleId ?? null, delayS: c.state.delayS });
            },
            cancel: (c) => c.done(undefined),
        },
    });
}
