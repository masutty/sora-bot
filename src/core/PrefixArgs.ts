import type {
    Guild,
    GuildBasedChannel,
    Role,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
    User,
} from "discord.js";
import { GuildMember } from "discord.js";
import type { BotClient } from "./BotClient";

// ─── Schema derivation ────────────────────────────────────────────────────────

type ArgType = "string" | "number" | "boolean" | "user" | "channel" | "role";

interface ArgSchema {
    name: string;
    type: ArgType;
    required: boolean;
}

interface SubcommandSchema {
    name: string;
    options: ArgSchema[];
}

const OPTION_TYPE_MAP: Record<number, ArgType | undefined> = {
    3: "string",
    4: "number",
    5: "boolean",
    6: "user",
    7: "channel",
    8: "role",
    10: "number",
};

const SUB_COMMAND = 1;

type AnyBuilder =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;

type RawOption = {
    name: string;
    type: number;
    required?: boolean;
    options?: RawOption[];
};

/**
 * Derives a flat arg schema from a builder (no subcommands).
 * Used by CommandHandler for regular commands.
 */
export function deriveSchema(builder: AnyBuilder): ArgSchema[] {
    const json = builder.toJSON() as { options?: RawOption[] };
    if (!json.options?.length) return [];
    return json.options.flatMap((opt): ArgSchema[] => {
        const type = OPTION_TYPE_MAP[opt.type];
        if (!type) return [];
        return [{ name: opt.name, type, required: opt.required ?? false }];
    });
}

/**
 * Derives a subcommand schema map from a builder.
 * Returns a map of subcommand name → its arg schemas.
 * Used by PrefixArgs when the builder has subcommands.
 */
export function deriveSubcommandSchema(builder: AnyBuilder): Map<string, SubcommandSchema> {
    const json = builder.toJSON() as { options?: RawOption[] };
    const map = new Map<string, SubcommandSchema>();
    if (!json.options?.length) return map;

    for (const opt of json.options) {
        if (opt.type !== SUB_COMMAND) continue;
        const options = (opt.options ?? []).flatMap((child): ArgSchema[] => {
            const type = OPTION_TYPE_MAP[child.type];
            if (!type) return [];
            return [{ name: child.name, type, required: child.required ?? false }];
        });
        map.set(opt.name, { name: opt.name, options });
    }

    return map;
}

// ─── ID resolvers ─────────────────────────────────────────────────────────────

function extractId(input: string, pattern: RegExp): string | null {
    const m = input.match(pattern);
    if (m) return m[1];
    if (/^\d{17,19}$/.test(input)) return input;
    return null;
}

// ─── PrefixArgs ───────────────────────────────────────────────────────────────

/**
 * Lightweight arg helper for prefix commands.
 *
 * Supports two modes:
 *
 * 1. Flat args — builder has regular options only.
 *    `args.getString("message")` maps positionally from the schema.
 *
 * 2. Subcommand mode — builder has .addSubcommand().
 *    First raw token is the subcommand name; remaining tokens are its args.
 *    Use `args.getSubcommand()` to get the active subcommand name.
 *    Arg getters (`getString`, etc.) resolve against the subcommand's schema.
 *
 * The last defined arg in a schema is always greedy (joins remaining tokens).
 */
export class PrefixArgs {
    private readonly activeSchema: ArgSchema[];
    private readonly activeRaw: string[];
    private readonly _subcommand: string | null;

    constructor(
        raw: string[],
        schema: ArgSchema[],
        private readonly guild: Guild | null,
        private readonly client: BotClient,
        subcommandMap?: Map<string, SubcommandSchema>,
    ) {
        if (subcommandMap && subcommandMap.size > 0) {
            // Subcommand mode: raw[0] = subcommand name, raw[1+] = its args
            const subName = raw[0]?.toLowerCase() ?? null;
            const sub = subName ? subcommandMap.get(subName) : null;
            this._subcommand = sub?.name ?? null;
            this.activeSchema = sub?.options ?? [];
            this.activeRaw = raw.slice(1);
        } else {
            // Flat mode
            this._subcommand = null;
            this.activeSchema = schema;
            this.activeRaw = raw;
        }
    }

    /**
     * Returns the active subcommand name, or null if not in subcommand mode.
     */
    getSubcommand(): string | null {
        return this._subcommand;
    }

    private getRaw(name: string): string | null {
        const idx = this.activeSchema.findIndex((a) => a.name === name);
        if (idx === -1) return null;
        // Last arg is greedy — joins all remaining tokens
        if (idx === this.activeSchema.length - 1 && this.activeRaw.length > idx) {
            return this.activeRaw.slice(idx).join(" ") || null;
        }
        return this.activeRaw[idx] ?? null;
    }

    getString(name: string): string | null {
        return this.getRaw(name);
    }

    getNumber(name: string): number | null {
        const raw = this.getRaw(name);
        if (raw === null) return null;
        const n = Number(raw);
        return isNaN(n) ? null : n;
    }

    getBoolean(name: string): boolean | null {
        const raw = this.getRaw(name)?.toLowerCase();
        if (!raw) return null;
        if (["true", "1", "yes", "sim"].includes(raw)) return true;
        if (["false", "0", "no", "não", "nao"].includes(raw)) return false;
        return null;
    }

    getUser(name: string): User | null {
        const raw = this.getRaw(name);
        if (!raw) return null;
        const id = extractId(raw, /^<@!?(\d+)>$/);
        return id ? (this.client.users.cache.get(id) ?? null) : null;
    }

    getMember(name: string): GuildMember | null {
        const user = this.getUser(name);
        return user ? (this.guild?.members.cache.get(user.id) ?? null) : null;
    }

    getChannel(name: string): GuildBasedChannel | null {
        const raw = this.getRaw(name);
        if (!raw) return null;
        const id = extractId(raw, /^<#(\d+)>$/);
        return id ? (this.guild?.channels.cache.get(id) ?? null) : null;
    }

    getRole(name: string): Role | null {
        const raw = this.getRaw(name);
        if (!raw) return null;
        const id = extractId(raw, /^<@&(\d+)>$/);
        return id ? (this.guild?.roles.cache.get(id) ?? null) : null;
    }
}
