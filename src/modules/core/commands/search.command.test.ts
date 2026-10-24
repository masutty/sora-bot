import { expect, test } from "bun:test";
import { type GuildMember, PermissionFlagsBits, SlashCommandBuilder, type User } from "discord.js";
import type { CommandDefinition } from "@/types";
import { config } from "../../../config";
import { type SearchViewer, searchCommands } from "./search.command";

const user = (id: string) => ({ id }) as unknown as User;
const member = (perms: bigint[] = []) =>
    ({
        permissions: { has: (p: bigint) => perms.includes(p) || perms.includes(PermissionFlagsBits.Administrator) },
    }) as unknown as GuildMember;

const viewer = (over: Partial<SearchViewer> = {}): SearchViewer => ({
    user: user("u1"),
    member: member(),
    inGuild: true,
    mode: "slash",
    prefix: "!",
    ...over,
});

const cmd = (def: Partial<CommandDefinition> & { name: string }): CommandDefinition =>
    ({ description: `${def.name} things`, showOnHelp: true, ...def }) as CommandDefinition;

const usages = async (commands: CommandDefinition[], query: string, v = viewer()) =>
    (await searchCommands(commands, query, v)).map((h) => h.usage);

const shop = cmd({
    name: "bh",
    options: new SlashCommandBuilder()
        .setName("bh")
        .setDescription("x")
        .addSubcommand((s) => s.setName("shop").setDescription("Spend your Seeds"))
        .addSubcommand((s) => s.setName("balance").setDescription("View your Seeds")),
});

test("lists each matching subcommand, name matches first", async () => {
    expect(await usages([shop], "shop")).toEqual(["/bh shop"]);
    expect(await usages([shop], "seeds")).toEqual(["/bh balance", "/bh shop"]);
    expect(await usages([shop], "bh shop")).toEqual(["/bh shop"]);
    expect(await usages([shop], "nothing")).toEqual([]);
});

test("searches nested group subcommands", async () => {
    const owner = cmd({
        name: "tools",
        options: new SlashCommandBuilder()
            .setName("tools")
            .setDescription("x")
            .addSubcommandGroup((g) =>
                g
                    .setName("biome")
                    .setDescription("x")
                    .addSubcommand((s) => s.setName("add").setDescription("Registers a new biome")),
            ),
    });
    expect(await usages([owner], "biome")).toEqual(["/tools biome add"]);
});

test("hidden commands never show", async () => {
    expect(await usages([cmd({ name: "secret", showOnHelp: false })], "secret")).toEqual([]);
});

test("bot-owner commands show only to owners", async () => {
    const dev = cmd({ name: "owner", botOwnerOnly: true });
    expect(await usages([dev], "owner")).toEqual([]);
    const ownerId = config.bot.ownerIds[0];
    if (ownerId) expect(await usages([dev], "owner", viewer({ user: user(ownerId) }))).toEqual(["/owner"]);
});

test("admin commands show only to admins, and never in DMs", async () => {
    const admin = cmd({ name: "admin", adminOnly: true });
    expect(await usages([admin], "admin")).toEqual([]);
    expect(await usages([admin], "admin", viewer({ member: member([PermissionFlagsBits.Administrator]) }))).toEqual(["/admin"]);
    expect(await usages([admin], "admin", viewer({ member: null, inGuild: false }))).toEqual([]);
});

test("allowed users, permissions and default member permissions are respected", async () => {
    expect(await usages([cmd({ name: "vip", allowedUsers: ["u2"] })], "vip")).toEqual([]);
    expect(await usages([cmd({ name: "vip", allowedUsers: ["u1"] })], "vip")).toEqual(["/vip"]);
    const mod = cmd({ name: "kick", permissions: [PermissionFlagsBits.KickMembers] });
    expect(await usages([mod], "kick")).toEqual([]);
    expect(await usages([mod], "kick", viewer({ member: member([PermissionFlagsBits.KickMembers]) }))).toEqual(["/kick"]);
    const locked = cmd({
        name: "locked",
        options: new SlashCommandBuilder()
            .setName("locked")
            .setDescription("x")
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    });
    expect(await usages([locked], "locked")).toEqual([]);
});

test("guild-only commands don't show in DMs", async () => {
    const g = cmd({ name: "setprefix", guildOnly: true });
    expect(await usages([g], "setprefix", viewer({ member: null, inGuild: false }))).toEqual([]);
    expect(await usages([g], "setprefix")).toEqual(["/setprefix"]);
});

test("usage follows the mode the command exists in", async () => {
    const prefixOnly = cmd({ name: "stats", modes: "prefix" });
    const slashOnly = cmd({ name: "report", modes: "slash" });
    expect(await usages([prefixOnly], "stats")).toEqual(["!stats"]);
    expect(await usages([prefixOnly], "stats", viewer({ mode: "prefix", prefix: "s!" }))).toEqual(["s!stats"]);
    expect(await usages([slashOnly], "report", viewer({ mode: "prefix", prefix: "s!" }))).toEqual(["/report"]);
    const both = cmd({ name: "ping" });
    expect(await usages([both], "ping", viewer({ mode: "prefix", prefix: "s!" }))).toEqual(["s!ping"]);
});

test("a slash-only subcommand shows as slash on a prefix search", async () => {
    const owner = cmd({
        name: "biomes",
        subcommandModes: { import: "slash" },
        options: new SlashCommandBuilder()
            .setName("biomes")
            .setDescription("x")
            .addSubcommand((s) => s.setName("import").setDescription("Applies a biome file"))
            .addSubcommand((s) => s.setName("export").setDescription("Downloads a biome file")),
    });
    expect(await usages([owner], "biome file", viewer({ mode: "prefix", prefix: "s!" }))).toEqual(["s!biomes export", "/biomes import"]);
});

test("a context-menu command shows where to find it", async () => {
    expect(await usages([cmd({ name: "Manage member", contextMenu: "user" })], "manage")).toEqual(["Apps → Manage member"]);
});
