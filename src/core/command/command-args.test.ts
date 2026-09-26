import { describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
import { type CommandArgs, prefixArgs, slashArgs } from "./command-args";
import { fakeClient, fakeGuild, fakeInteraction, fakeMember, fakeUser } from "./fakes";
import { deriveSubcommandSchema, PrefixArgs } from "./prefix-args";
import { UserFacingError } from "./user-facing-error";

const builder = new SlashCommandBuilder()
    .setName("x")
    .setDescription("x")
    .addSubcommand((s) =>
        s.setName("profile").setDescription("p").addUserOption((o) => o.setName("user").setDescription("u")),
    )
    .addSubcommand((s) =>
        s.setName("set").setDescription("s").addIntegerOption((o) => o.setName("count").setDescription("c").setRequired(true)),
    )
    .addSubcommandGroup((g) =>
        g.setName("forward").setDescription("f")
            .addSubcommand((s) => s.setName("list").setDescription("l")),
    );

const subMap = deriveSubcommandSchema(builder);

function prefix(tokens: string[], guild = fakeGuild(), users: Record<string, ReturnType<typeof fakeUser>> = {}): CommandArgs {
    return prefixArgs(new PrefixArgs(tokens, [], guild, fakeClient(users), subMap));
}

function slash(sub: string | null, values: Record<string, unknown>, guild = fakeGuild(), group: string | null = null): CommandArgs {
    return slashArgs(fakeInteraction({ sub, group, values, guild }));
}

describe("slash and prefix resolve the same logical input identically", () => {
    test("absent optional user -> null on both", async () => {
        expect(await slash("profile", {}).getMember("user")).toBeNull();
        expect(await prefix(["profile"]).getMember("user")).toBeNull();
    });

    test("supplied member in the guild -> that member on both", async () => {
        const m1 = fakeMember("111111111111111111");
        const guild = fakeGuild({ members: { "111111111111111111": m1 } });
        expect(await slash("profile", { user: fakeUser("111111111111111111") }, guild).getMember("user")).toBe(m1);
        expect(await prefix(["profile", "<@111111111111111111>"], guild).getMember("user")).toBe(m1);
    });

    test("supplied user who isn't in the guild -> UserFacingError on both", async () => {
        const u2 = fakeUser("222222222222222222");
        await expect(slash("profile", { user: u2 }).getMember("user")).rejects.toBeInstanceOf(UserFacingError);
        await expect(prefix(["profile", "<@222222222222222222>"], fakeGuild(), { "222222222222222222": u2 }).getMember("user"))
            .rejects.toBeInstanceOf(UserFacingError);
    });

    test("required integer missing -> 'Missing required argument' on both", () => {
        expect(() => slash("set", {}).getInteger("count", true)).toThrow("Missing required argument: `count`");
        expect(() => prefix(["set"]).getInteger("count", true)).toThrow("Missing required argument: `count`");
    });

    test("subcommand and group names match", () => {
        expect(slash("profile", {}).getSubcommand()).toBe("profile");
        expect(prefix(["profile"]).getSubcommand()).toBe("profile");
        expect(slash("list", {}, fakeGuild(), "forward").getSubcommandGroup()).toBe("forward");
        expect(prefix(["forward", "list"]).getSubcommandGroup()).toBe("forward");
    });
});

describe("prefix-only input shapes", () => {
    test("a decimal for an integer option is rejected, not truncated", () => {
        expect(() => prefix(["set", "2.5"]).getInteger("count")).toThrow("`count` must be a whole number.");
        expect(() => prefix(["set", "2.5"]).getInteger("count", true)).toThrow("`count` must be a whole number.");
    });

    test("a supplied but unparseable user is an error, not silently absent", async () => {
        await expect(prefix(["profile", "not-a-mention"]).getMember("user")).rejects.toBeInstanceOf(UserFacingError);
    });

    test("a bare group token sets the group with no subcommand", () => {
        const args = prefix(["forward"]);
        expect(args.getSubcommandGroup()).toBe("forward");
        expect(args.getSubcommand()).toBeNull();
    });

    test("has() is true for a supplied value, even an invalid one", () => {
        expect(prefix(["set", "2.5"]).has("count")).toBe(true);
        expect(prefix(["set"]).has("count")).toBe(false);
    });
});

describe("review fixes", () => {
    test("an optional value that is supplied but unparseable is an error, not silently null", () => {
        expect(() => prefix(["set", "abc"]).getInteger("count")).toThrow("`count` must be a whole number.");
    });

    test("slash numeric getters don't throw a TypeError when an integer option is read as a number", () => {
        const args = slashArgs(fakeInteraction({ sub: "set", values: { count: 3 }, types: { count: 4 }, guild: fakeGuild() }));
        expect(args.getNumber("count")).toBe(3);
        expect(args.getInteger("count")).toBe(3);
    });
});
