import { MessageFlags } from "discord.js";
import { defineComponent } from "@/define";
import * as repo from "../repository/panels.repository";
import type { OptionRow, PanelRow } from "../types";
import { buildOptionPage, buildRootPage, PICK_PREFIX, type PickSource } from "../views/panel.render";

/** What the handler reads, injected so tests never hit the database. */
export interface PickDeps {
    getPanel(panelId: number): Promise<PanelRow | null>;
    listOptions(panelId: number): Promise<OptionRow[]>;
}

const defaultDeps: PickDeps = { getPanel: repo.getPanel, listOptions: repo.listOptions };

/**
 * `infopanel:pick:<panelId>:<root|eph>` - the select of a posted panel (`root`) and the one on an
 * option page (`eph`). From the root it answers privately and puts the channel message back to its
 * start, so picking the same option twice still fires; from an option page it swaps the page in place.
 */
export function panelPickComponent(deps: PickDeps = defaultDeps) {
    return defineComponent({
        prefix: PICK_PREFIX,
        handle: async (interaction, parts) => {
            if (!interaction.isStringSelectMenu()) return;
            const panelId = Number(parts[0]);
            const source: PickSource = parts[1] === "eph" ? "eph" : "root";
            const gone = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

            const panel = Number.isInteger(panelId) ? await deps.getPanel(panelId) : null;
            if (!panel || panel.guild_id !== interaction.guildId) {
                await gone("This panel no longer exists.");
                return;
            }
            const options = await deps.listOptions(panel.id);
            const option = options.find((o) => String(o.id) === interaction.values[0]);
            if (!option) {
                await gone("This option no longer exists.");
                return;
            }

            const page = buildOptionPage(panel, options, option);
            if (source === "eph") {
                await interaction.update(page);
                return;
            }
            await interaction.update(buildRootPage(panel, options));
            await interaction.followUp({ ...page, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        },
    });
}
