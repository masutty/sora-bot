import { expect, test } from "bun:test";
import { type Client, type Guild, PermissionFlagsBits } from "discord.js";
import { canMention, postStatus, roleExists } from "./post-status";

function fakeClient(opts: { guild?: boolean; available?: boolean; channel?: boolean; perms?: bigint[] }): Client {
    const has = (p: bigint) => (opts.perms ?? []).includes(p);
    const channel = { permissionsFor: () => ({ has }) };
    const guild = {
        available: opts.available ?? true,
        members: { me: {} },
        channels: { cache: new Map(opts.channel === false ? [] : [["c1", channel]]) },
    };
    return { guilds: { cache: new Map(opts.guild === false ? [] : [["g1", guild]]) } } as unknown as Client;
}

const BOTH = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

test("postStatus: null channel", () => {
    expect(postStatus(fakeClient({}), "g1", null)).toBe("no_channel");
});
test("postStatus: guild missing or unavailable", () => {
    expect(postStatus(fakeClient({ guild: false }), "g1", "c1")).toBe("not_in_guild");
    expect(postStatus(fakeClient({ available: false }), "g1", "c1")).toBe("not_in_guild");
});
test("postStatus: channel missing", () => {
    expect(postStatus(fakeClient({ channel: false }), "g1", "c1")).toBe("channel_missing");
});
test("postStatus: missing permissions", () => {
    expect(postStatus(fakeClient({ perms: [PermissionFlagsBits.ViewChannel] }), "g1", "c1")).toBe("no_permission");
    expect(postStatus(fakeClient({ perms: [PermissionFlagsBits.SendMessages] }), "g1", "c1")).toBe("no_permission");
});
test("postStatus: ok", () => {
    expect(postStatus(fakeClient({ perms: BOTH }), "g1", "c1")).toBe("ok");
});

function fakeGuild(mentionable: boolean | null, mentionEveryone: boolean): Guild {
    return {
        roles: { cache: new Map(mentionable === null ? [] : [["r1", { mentionable }]]) },
        members: { me: { permissions: { has: (p: bigint) => mentionEveryone && p === PermissionFlagsBits.MentionEveryone } } },
    } as unknown as Guild;
}

test("canMention", () => {
    expect(canMention(fakeGuild(true, false), "r1")).toBe(true);
    expect(canMention(fakeGuild(false, true), "r1")).toBe(true);
    expect(canMention(fakeGuild(false, false), "r1")).toBe(false);
});

test("roleExists", () => {
    const client = { guilds: { cache: new Map([["g1", fakeGuild(true, false)]]) } } as unknown as Client;
    expect(roleExists(client, "g1", "r1")).toBe(true);
    expect(roleExists(client, "g1", "nope")).toBe(false);
    expect(roleExists(client, "other", "r1")).toBe(false);
});
