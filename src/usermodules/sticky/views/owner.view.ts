import { ButtonStyle, ContainerBuilder, MessageFlags } from "discord.js";
import { defineView, type HandlerContext, type ViewDefinition } from "@/define";
import { NO_PINGS } from "@/utils/format";
import type * as limitsRepo from "../repository/limits.repository";
import { settings } from "../settings";
import { StickyError } from "../types";

export interface OwnerDeps {
    limits: Pick<typeof limitsRepo, "getDefaultLimit" | "setDefaultLimit" | "setGuildLimit" | "listGuildLimits">;
    usage(): Promise<Array<{ guild_id: string; count: number }>>;
    /** Null when the bot is not in that guild. */
    guildName(guildId: string): string | null;
}

export interface OwnerState {
    defaultLimit: number;
    overrides: Record<string, number>;
    used: Record<string, number>;
}

const MIN_LIMIT = 1;
const MAX_DEFAULT_LIMIT = 25;
const MAX_GUILD_LIMIT = 25;
const SNOWFLAKE = /^\d{17,20}$/;

type Ctx = HandlerContext<OwnerState, void>;

function parseLimit(raw: string, max: number): number {
    const text = raw.trim();
    const n = Number(text);
    if (!/^\d+$/.test(text) || n < MIN_LIMIT || n > max) throw new StickyError(`Use a number from ${MIN_LIMIT} to ${max}.`);
    return n;
}

/** `/sticky-owner`: the default limit and per-server overrides. */
export function ownerView(deps: OwnerDeps): ViewDefinition<OwnerState, void, void> {
    const { limits } = deps;

    async function load(): Promise<OwnerState> {
        const [defaultLimit, overrideRows, usageRows] = await Promise.all([
            limits.getDefaultLimit(),
            limits.listGuildLimits(),
            deps.usage(),
        ]);
        return {
            defaultLimit,
            overrides: Object.fromEntries(overrideRows.map((r) => [r.guild_id, r.max_stickies])),
            used: Object.fromEntries(usageRows.map((r) => [r.guild_id, r.count])),
        };
    }

    async function attempt(c: Ctx, action: () => Promise<void>): Promise<void> {
        try {
            await action();
            Object.assign(c.state, await load());
        } catch (err) {
            if (!(err instanceof StickyError)) throw err;
            await c.notify(err.message);
        }
    }

    return defineView<OwnerState, void, void>({
        name: "sticky.owner",
        initial: load,
        access: "invoker",
        render: (s, kit) => {
            const ids = [...new Set([...Object.keys(s.used), ...Object.keys(s.overrides)])];
            const lines = ids.flatMap((id) => {
                const name = deps.guildName(id);
                if (name === null) return [];
                const custom = s.overrides[id];
                return [`${name}: ${s.used[id] ?? 0}/${custom ?? s.defaultLimit}${custom === undefined ? "" : " (custom)"}`];
            });
            const container = new ContainerBuilder()
                .setAccentColor(settings.accentColor)
                .addTextDisplayComponents((td) =>
                    td.setContent(["**Sticky settings**", `Default limit: ${s.defaultLimit}`, ...lines].join("\n")),
                )
                .addActionRowComponents(
                    kit.row(
                        kit.button("defaultLimit", (b) => b.setLabel("Default limit").setStyle(ButtonStyle.Primary)),
                        kit.button("guildLimit", (b) => b.setLabel("Server limit").setStyle(ButtonStyle.Secondary)),
                    ),
                );
            return { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: NO_PINGS };
        },
        on: {
            defaultLimit: async (c) => {
                const values = await c.modal({
                    title: "Default limit",
                    fields: [
                        {
                            key: "limit",
                            label: `Stickies per server (${MIN_LIMIT}-${MAX_DEFAULT_LIMIT})`,
                            required: true,
                            maxLength: 2,
                            value: String(c.state.defaultLimit),
                        },
                    ],
                });
                if (!values) return;
                await attempt(c, () => limits.setDefaultLimit(parseLimit(values.limit ?? "", MAX_DEFAULT_LIMIT)));
            },
            guildLimit: async (c) => {
                const values = await c.modal({
                    title: "Server limit",
                    fields: [
                        { key: "guild", label: "Server ID", required: true, maxLength: 20 },
                        { key: "limit", label: `Limit (${MIN_LIMIT}-${MAX_GUILD_LIMIT}, empty clears)`, required: false, maxLength: 3 },
                    ],
                });
                if (!values) return;
                await attempt(c, () => {
                    const guildId = (values.guild ?? "").trim();
                    if (!SNOWFLAKE.test(guildId)) throw new StickyError("That is not a server ID.");
                    const raw = (values.limit ?? "").trim();
                    return limits.setGuildLimit(guildId, raw === "" ? null : parseLimit(raw, MAX_GUILD_LIMIT));
                });
            },
        },
    });
}
