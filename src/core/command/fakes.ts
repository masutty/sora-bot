/**
 * Minimal hand-rolled stand-ins for the discord.js objects the command layer touches - just the
 * members it actually reads, cast to the real types. Test-only: never import from runtime code.
 */
import type { ChatInputCommandInteraction, Guild, GuildBasedChannel, GuildMember, Role, User } from "discord.js";
import type { BotClient } from "../bot-client";

export function fakeUser(id: string): User {
    return { id, username: `user${id}` } as unknown as User;
}

export function fakeMember(id: string): GuildMember {
    return { id, user: fakeUser(id) } as unknown as GuildMember;
}

function fakeManager<T>(items: Record<string, T>) {
    return {
        cache: new Map<string, T>(),
        fetch: async (id: string): Promise<T> => {
            const item = items[id];
            if (item === undefined) throw new Error(`Unknown ${id}`);
            return item;
        },
    };
}

export function fakeGuild(opts: {
    members?: Record<string, GuildMember>;
    channels?: Record<string, GuildBasedChannel>;
    roles?: Record<string, Role>;
} = {}): Guild {
    return {
        id: "guild1",
        members: fakeManager(opts.members ?? {}),
        channels: fakeManager(opts.channels ?? {}),
        roles: fakeManager(opts.roles ?? {}),
    } as unknown as Guild;
}

export function fakeClient(users: Record<string, User> = {}): BotClient {
    return { users: fakeManager(users) } as unknown as BotClient;
}

/** `values` holds what Discord would have resolved per option name (a User object for user options, etc). */
export function fakeInteractionOptions(opts: { sub?: string | null; group?: string | null; values?: Record<string, unknown> }) {
    const values = opts.values ?? {};
    const get = <T>(name: string): T | null => (name in values ? (values[name] as T) : null);
    return {
        getSubcommand: () => opts.sub ?? null,
        getSubcommandGroup: () => opts.group ?? null,
        get: (name: string) => (name in values ? { name, value: values[name] } : null),
        getString: (name: string) => get<string>(name),
        getInteger: (name: string) => get<number>(name),
        getNumber: (name: string) => get<number>(name),
        getBoolean: (name: string) => get<boolean>(name),
        getUser: (name: string) => get<User>(name),
        getChannel: (name: string) => get<{ id: string }>(name),
        getRole: (name: string) => get<{ id: string }>(name),
    };
}

export function fakeInteraction(opts: {
    sub?: string | null;
    group?: string | null;
    values?: Record<string, unknown>;
    guild?: Guild | null;
}): ChatInputCommandInteraction {
    return {
        options: fakeInteractionOptions(opts),
        guild: opts.guild ?? null,
    } as unknown as ChatInputCommandInteraction;
}
