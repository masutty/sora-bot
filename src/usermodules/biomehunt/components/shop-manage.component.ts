import { type GuildMember, MessageFlags, PermissionFlagsBits } from "discord.js";
import { defineComponent, type RunViewOptions, runView } from "@/define";
import { normalizePurchaseCode } from "../constants/shop.constants";
import type { ShopDeps } from "../services/shop.service";
import { defaultShopDeps } from "../services/shop-deps.service";
import { purchaseCardView, SHOP_MANAGE_PREFIX } from "../views/shop-purchase.view";

/**
 * `biomehunt:shop-manage:<code>` - the Manage button on a sale post. Administrators only; opens the
 * purchase card privately for the clicker. `viewTransport` is a test seam.
 */
export function shopManageComponent(deps?: ShopDeps, viewTransport?: RunViewOptions["transportFactory"]) {
    return defineComponent({
        prefix: SHOP_MANAGE_PREFIX,
        handle: async (interaction, parts, client) => {
            if (!interaction.isButton()) return;
            const member = interaction.member as GuildMember | null;
            if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
                await interaction.reply({ content: "Only admins can manage purchases.", flags: MessageFlags.Ephemeral });
                return;
            }
            // Acknowledged first: the lookup below must not eat Discord's 3s window.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const shopDeps = deps ?? defaultShopDeps(client);
            const code = normalizePurchaseCode(parts[0] ?? "");
            const purchase = code && interaction.guildId ? await shopDeps.getPurchaseByCode(interaction.guildId, code) : null;
            if (!code || !interaction.guildId || !purchase) {
                await interaction.editReply({ content: "This purchase no longer exists." });
                return;
            }
            await runView(
                purchaseCardView(shopDeps),
                { guildId: interaction.guildId, code, fromMenu: false },
                {
                    respond: (payload) => interaction.editReply(payload as never),
                    invoker: interaction.user,
                    editMessage: (message, payload) => interaction.webhook.editMessage(message, payload as never),
                    transportFactory: viewTransport,
                },
            );
        },
    });
}
