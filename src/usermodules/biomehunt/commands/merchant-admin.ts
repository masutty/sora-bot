import {
    type AutocompleteInteraction,
    MessageFlags,
    type SlashCommandSubcommandBuilder,
    type SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import type { CommandContext } from "@/define";
import { type FormattedReply, NO_PINGS } from "@/utils/format";
import { getAllMerchants, type MerchantEntry } from "../constants/merchants.constants";
import { addMerchant, editMerchant, setMerchantActive } from "../services/merchant-admin.service";
import { BiomeHuntError } from "../types";
import { buildMerchantCard, merchantListView } from "../views/merchant-list.view";

function addFields(s: SlashCommandSubcommandBuilder, required: boolean): SlashCommandSubcommandBuilder {
    const removable = required ? "" : ' ("none" removes it)';
    return s
        .addStringOption((o) => o.setName("color").setDescription("6 hex digits without #, like ff8c00").setRequired(required))
        .addStringOption((o) => o.setName("flavor_text").setDescription(`One line under the title on forward cards${removable}`))
        .addStringOption((o) => o.setName("icon_url").setDescription(`https:// image on forward cards${removable}`))
        .addStringOption((o) => o.setName("emoji").setDescription(`Shown before its name, unicode or custom${removable}`));
}

const merchantOption = (s: SlashCommandSubcommandBuilder) =>
    s.addStringOption((o) => o.setName("merchant").setDescription("Merchant").setRequired(true).setAutocomplete(true));

/** `/owner merchant ...` - the bot owner's runtime merchant registry (see `bh_merchants`). */
export function merchantAdminSubcommandGroup(g: SlashCommandSubcommandGroupBuilder): SlashCommandSubcommandGroupBuilder {
    return g
        .setName("merchant")
        .setDescription("Add, edit, enable or disable the merchants the bot recognizes.")
        .addSubcommand((s) =>
            addFields(
                s
                    .setName("add")
                    .setDescription("Registers a new merchant.")
                    .addStringOption((o) => o.setName("name").setDescription("Name as macros write it").setRequired(true).setMaxLength(60)),
                true,
            ),
        )
        .addSubcommand((s) =>
            addFields(
                merchantOption(s.setName("edit").setDescription("Changes a merchant's fields - only the ones given.")).addStringOption(
                    (o) => o.setName("name").setDescription("New display name").setMaxLength(60),
                ),
                false,
            ),
        )
        .addSubcommand((s) => merchantOption(s.setName("disable").setDescription("Stops recording and forwarding a merchant.")))
        .addSubcommand((s) => merchantOption(s.setName("enable").setDescription("Turns a disabled merchant back on.")))
        .addSubcommand((s) => s.setName("list").setDescription("Lists every merchant and edits them."));
}

export function merchantAutocompleteChoices(typed: string): Array<{ name: string; value: string }> {
    const wanted = typed.trim().toLowerCase();
    return getAllMerchants()
        .filter((m) => m.label.toLowerCase().includes(wanted))
        .slice(0, 25)
        .map((m) => ({ name: m.label, value: m.key }));
}

export async function respondMerchantAutocomplete(interaction: AutocompleteInteraction, typed: string): Promise<void> {
    await interaction.respond(merchantAutocompleteChoices(typed));
}

const card = (m: MerchantEntry): FormattedReply => ({
    components: [buildMerchantCard(m)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_PINGS,
});

/** `/owner merchant <sub>` - the caller already deferred ephemerally. */
export async function runMerchantAdminSubcommand(ctx: CommandContext): Promise<void> {
    const args = ctx.args;
    const changes = () => ({
        name: args.getString("name"),
        color: args.getString("color"),
        flavorText: args.getString("flavor_text"),
        iconUrl: args.getString("icon_url"),
        emoji: args.getString("emoji"),
    });
    switch (args.getSubcommand()) {
        case "add":
            await ctx.reply(
                card(await addMerchant({ ...changes(), name: args.getString("name", true), color: args.getString("color", true) })),
            );
            return;
        case "edit":
            await ctx.reply(card(await editMerchant(args.getString("merchant", true), changes())));
            return;
        case "disable":
        case "enable":
            await ctx.reply(card(await setMerchantActive(args.getString("merchant", true), args.getSubcommand() === "enable")));
            return;
        case "list":
            await ctx.open(merchantListView(), undefined);
            return;
        default:
            throw new BiomeHuntError(`Unknown subcommand: ${args.getSubcommand()}`);
    }
}
