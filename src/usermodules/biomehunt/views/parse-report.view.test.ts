import { expect, test } from "bun:test";
import { inspectMessage } from "../macro-parsers";
import { parseMessageReference } from "../services/message-reference.service";
import { buildParseReport } from "./parse-report.view";

const source = {
    webhookId: "w",
    tracked: { userId: 1, guildId: "g", webhookId: "w" },
    url: "https://discord.com/channels/1/2/3",
    recorded: null,
};
const report = (title: string) =>
    buildParseReport(inspectMessage({ webhookId: "w", embeds: [{ title, footer: { text: "MultiScope | v0.9.9.1-Stable" } }] }), source)
        .data;

test("a read biome start shows the parser and the matched text", () => {
    const { description, color } = report("🌀 WINDY Biome Started");
    expect(description).toContain("Parser: `multiscope`");
    expect(description).toContain("**title** ✅ `WINDY` (started)");
    expect(description).toContain("✅ Biome start");
    expect(color).toBe(0x248046);
});

test("an unreadable message shows why", () => {
    const { description, color } = report("📊 Status Update: MultiScope Started");
    expect(description).toContain("**title** ❌ no match");
    expect(description).toContain("Biome: none");
    expect(color).toBe(0xda373c);
});

test("shows what the bot stored for the message", () => {
    const recorded = { id: 5, biome: "WINDY", macro_type: "multiscope", event_type: null, received_at: new Date(1_000_000) };
    const { description } = buildParseReport(inspectMessage({ webhookId: "w", embeds: [] }), { ...source, recorded }).data;
    expect(description).toContain("Recorded: `#5` `WINDY` (no event type, multiscope) <t:1000:T>");
    expect(report("x").description).toContain("Recorded: no");
});

test("a message reference is a link, or an id in the current channel", () => {
    const id = "1575480119227846751";
    expect(parseMessageReference("https://ptb.discord.com/channels/1/2/3", "9")).toEqual({ channelId: "2", messageId: "3" });
    expect(parseMessageReference(id, "9")).toEqual({ channelId: "9", messageId: id });
    expect(parseMessageReference("nope", "9")).toBeNull();
});
