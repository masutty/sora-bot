import { expect, test } from "bun:test";
import { type ContainerBuilder, SlashCommandBuilder } from "discord.js";
import type { CommandDefinition } from "../../types";
import { buildHelpContainer } from "./command-usage";

const cmd = {
    name: "bot",
    description: "Bot tools",
    subcommandModes: { db: "slash", run: "prefix" },
    options: new SlashCommandBuilder()
        .setName("bot")
        .setDescription("Bot tools")
        .addSubcommand((s) => s.setName("status").setDescription("Show status"))
        .addSubcommand((s) => s.setName("db").setDescription("DB stats"))
        .addSubcommand((s) => s.setName("run").setDescription("Run code")),
} as CommandDefinition;

const text = (c: ContainerBuilder | null) => JSON.stringify(c?.toJSON());

test("prefix usage lists only subcommands available on prefix", () => {
    const usage = text(buildHelpContainer("!", cmd, [], false, "prefix"));
    expect(usage).toContain("!bot status");
    expect(usage).toContain("!bot run");
    expect(usage).not.toContain("!bot db");
});

test("slash usage lists only subcommands available on slash", () => {
    const usage = text(buildHelpContainer("/", cmd, [], false, "slash"));
    expect(usage).toContain("/bot db");
    expect(usage).not.toContain("/bot run");
});
