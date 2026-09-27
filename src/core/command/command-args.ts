import { type ChatInputCommandInteraction, type Guild, type GuildBasedChannel, GuildMember, type Role, type User } from "discord.js";
import type { PrefixArgs } from "./prefix-args";
import { UserFacingError } from "./user-facing-error";

/**
 * A command's arguments with ONE API for both invocation modes - `run(ctx)` reads `ctx.args` and
 * never needs to know whether it came from a slash interaction or a prefix message.
 *
 * Semantics (identical in both modes):
 * - Primitive getters return `null` only when the value is absent (`required: true` turns that
 *   into "Missing required argument"). Supplied but unparseable (e.g. `2.5` for an integer on
 *   prefix) always throws a type message. Both are UserFacingError, shown verbatim to the user.
 *   Prefix does NOT enforce min/max/choices/length yet - validate those in the command if they matter.
 * - Entity getters (user/member/channel/role) return `null` only when the option wasn't supplied.
 *   Supplied-but-unresolvable (a user who left, a garbage mention) throws UserFacingError - it's
 *   never silently treated as absent, which would e.g. show the invoker's own profile instead.
 */
export interface CommandArgs {
    getSubcommand(): string | null;
    getSubcommandGroup(): string | null;
    /** True if the invoker supplied a value for this option (even an invalid one). */
    has(name: string): boolean;
    /** What was parsed, as `name=`value`` pairs (empty when nothing) - appended to user-error replies and logs. */
    describe(): string;
    getString(name: string, required: true): string;
    getString(name: string, required?: false): string | null;
    getInteger(name: string, required: true): number;
    getInteger(name: string, required?: false): number | null;
    getNumber(name: string, required: true): number;
    getNumber(name: string, required?: false): number | null;
    getBoolean(name: string, required: true): boolean;
    getBoolean(name: string, required?: false): boolean | null;
    getUser(name: string): Promise<User | null>;
    getMember(name: string): Promise<GuildMember | null>;
    getChannel(name: string): Promise<GuildBasedChannel | null>;
    getRole(name: string): Promise<Role | null>;
}

const NOT_A_MEMBER = "That user isn't a member of this server.";
const UNKNOWN_USER = "Couldn't find that user.";
const UNKNOWN_CHANNEL = "Couldn't find that channel.";
const UNKNOWN_ROLE = "Couldn't find that role.";

type Primitive = "string" | "integer" | "number" | "boolean";
const TYPE_MESSAGE: Record<Primitive, string> = {
    string: "must be text",
    integer: "must be a whole number",
    number: "must be a number",
    boolean: "must be true or false",
};

/** Shared required/absent/invalid policy for primitive getters, so both adapters phrase errors identically. */
function primitive<T>(name: string, kind: Primitive, value: T | null, supplied: boolean, required?: boolean): T | null {
    if (value !== null) return value;
    if (supplied) throw new UserFacingError(`\`${name}\` ${TYPE_MESSAGE[kind]}.`);
    if (required) throw new UserFacingError(`Missing required argument: \`${name}\``);
    return null;
}

/**
 * Reads a slash option's raw value and checks its kind here - discord.js's typed getters throw a
 * TypeError on e.g. getNumber() of an integer option, which prefix (number types alike) would never
 * surface, so such a mismatch would only ever break on slash.
 */
function slashValue(o: ChatInputCommandInteraction["options"], name: string, kind: Primitive): never | null {
    const v = o.get(name)?.value;
    if (v === undefined || v === null) return null;
    const ok =
        kind === "string" ? typeof v === "string"
        : kind === "integer" ? typeof v === "number" && Number.isInteger(v)
        : kind === "number" ? typeof v === "number"
        : typeof v === "boolean";
    return ok ? (v as never) : null;
}

async function fromGuild<T>(
    guild: Guild | null,
    id: string,
    manager: (g: Guild) => { cache: Map<string, T>; fetch: (id: string) => Promise<T | null> },
): Promise<T | null> {
    if (!guild) return null;
    const m = manager(guild);
    return m.cache.get(id) ?? (await m.fetch(id).catch(() => null));
}

export function slashArgs(interaction: ChatInputCommandInteraction): CommandArgs {
    const o = interaction.options;
    const guild = interaction.guild;
    const has = (name: string) => o.get(name) !== null;

    // Overloads are satisfied structurally; the `required` flag only changes null -> throw.
    const args = {
        getSubcommand: () => o.getSubcommand(false),
        getSubcommandGroup: () => o.getSubcommandGroup(false),
        describe: () => describeSlashOptions(o.data ?? []),
        has,
        getString: (name: string, required?: boolean) => primitive<string>(name, "string", slashValue(o, name, "string"), has(name), required),
        getInteger: (name: string, required?: boolean) => primitive<number>(name, "integer", slashValue(o, name, "integer"), has(name), required),
        getNumber: (name: string, required?: boolean) => primitive<number>(name, "number", slashValue(o, name, "number"), has(name), required),
        getBoolean: (name: string, required?: boolean) => primitive<boolean>(name, "boolean", slashValue(o, name, "boolean"), has(name), required),
        async getUser(name: string) {
            return o.getUser(name);
        },
        async getMember(name: string) {
            const user = o.getUser(name);
            if (!user) return null;
            if (!guild) return null;
            // Usually already resolved in the interaction payload - skip the fetch when it is.
            const resolved = o.getMember(name);
            if (resolved instanceof GuildMember) return resolved;
            const member = await fromGuild(guild, user.id, (g) => g.members);
            if (!member) throw new UserFacingError(NOT_A_MEMBER);
            return member;
        },
        async getChannel(name: string) {
            const raw = o.getChannel(name);
            if (!raw || !guild) return null;
            const channel = await fromGuild(guild, raw.id, (g) => g.channels as never);
            if (!channel) throw new UserFacingError(UNKNOWN_CHANNEL);
            return channel as GuildBasedChannel;
        },
        async getRole(name: string) {
            const raw = o.getRole(name);
            if (!raw || !guild) return null;
            const role = await fromGuild(guild, raw.id, (g) => g.roles as never);
            if (!role) throw new UserFacingError(UNKNOWN_ROLE);
            return role as Role;
        },
    };
    return args as CommandArgs;
}

export function prefixArgs(a: PrefixArgs): CommandArgs {
    const entity = async <T>(name: string, get: () => Promise<T | null>, message: string): Promise<T | null> => {
        if (!a.has(name)) return null;
        const value = await get();
        if (!value) throw new UserFacingError(message);
        return value;
    };

    const args = {
        getSubcommand: () => a.getSubcommand(),
        getSubcommandGroup: () => a.getSubcommandGroup(),
        describe: () => a.describe(),
        has: (name: string) => a.has(name),
        getString: (name: string, required?: boolean) => primitive(name, "string", a.getString(name), a.has(name), required),
        getInteger: (name: string, required?: boolean) => primitive(name, "integer", a.getInteger(name), a.has(name), required),
        getNumber: (name: string, required?: boolean) => primitive(name, "number", a.getNumber(name), a.has(name), required),
        getBoolean: (name: string, required?: boolean) => primitive(name, "boolean", a.getBoolean(name), a.has(name), required),
        getUser: (name: string) => entity(name, () => a.getUser(name), UNKNOWN_USER),
        getMember: (name: string) => entity(name, () => a.getMember(name), NOT_A_MEMBER),
        getChannel: (name: string) => entity(name, () => a.getChannel(name), UNKNOWN_CHANNEL),
        getRole: (name: string) => entity(name, () => a.getRole(name), UNKNOWN_ROLE),
    };
    return args as CommandArgs;
}

type RawSlashOption = { name: string; value?: unknown; options?: readonly RawSlashOption[] };

/** Flattens slash option data (subcommand / group nesting included) into `name=\`value\`` pairs. */
function describeSlashOptions(options: readonly RawSlashOption[]): string {
    const flat = (list: readonly RawSlashOption[]): string[] =>
        list.flatMap((opt) => (opt.options ? flat(opt.options) : opt.value !== undefined ? [`${opt.name}=\`${opt.value}\``] : []));
    return flat(options).join(" ");
}
