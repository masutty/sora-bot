import { ButtonStyle, ChannelType, ContainerBuilder, MessageFlags } from "discord.js";
import { defineView, type ViewDefinition, type ViewPayload } from "@/define";
import { NO_PINGS } from "@/utils/format";
import { BIOME_SELECTOR_CHOICES } from "../constants/biomes.constants";
import { settings } from "../settings";
import type { ForwardListVariant } from "./forward-list.view";

export interface CreatedForward {
    biome: string;
    channelId: string;
    roleId: string | null;
    /** Only set by the "delayed" variant. */
    delayS?: number;
}

interface CreateForwardState {
    biome?: string;
    channelId?: string;
    roleId?: string;
    delayS?: number;
}

/**
 * Single screen with a biome select, a channel select, and an optional role select (plus a delay
 * select for the "delayed" variant), confirmed with a button - `biomehunt.forward-create`, a child
 * of `biomehunt.forward-list`'s "Create". Resolves the forward to create, or `undefined` on Cancel.
 */
export function forwardCreateView(
    variant: ForwardListVariant = "live",
): ViewDefinition<CreateForwardState, CreatedForward | undefined, void> {
    const delayed = variant === "delayed";
    const isComplete = (state: CreateForwardState) => Boolean(state.biome && state.channelId && (!delayed || state.delayS !== undefined));

    return defineView<CreateForwardState, CreatedForward | undefined, void>({
        name: delayed ? "biomehunt.delayed-forward-create" : "biomehunt.forward-create",
        initial: () => ({}),
        render: (state, kit): ViewPayload => {
            const biomeMenu = kit.stringSelect("biome", (s) =>
                s
                    .setPlaceholder("Select biome")
                    .addOptions(BIOME_SELECTOR_CHOICES.map(({ name, value }) => ({ label: name, value, default: value === state.biome }))),
            );
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
                    kit.row(biomeMenu),
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
            biome: (c) => {
                c.state.biome = c.values[0];
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
