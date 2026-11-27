import { expect, test } from "bun:test";
import { createFakeViewTransport } from "@/define";
import { inspectMessage } from "../macro-parsers";
import { fetchReferencedMessage, parseMessageReference } from "../services/message-reference.service";
import { type ParseReportData, parseReportView } from "./parse-report.view";

const OWNER = "1";

async function open(title: string, overrides: Partial<ParseReportData> = {}) {
    const inspection = inspectMessage({
        webhookId: "w",
        embeds: [{ title, description: "https://www.roblox.com/share?code=secret123&type=Server", footer: { text: "MultiScope" } }],
    });
    const fake = createFakeViewTransport();
    void fake.run(
        parseReportView(),
        {
            inspection,
            webhookId: "w",
            tracked: { userId: 1, guildId: "g", webhookId: "w" },
            url: "https://discord.com/channels/1/2/3",
            messageId: "3",
            memberId: "7",
            recorded: null,
            record: { session: null, reward: null, vote: null, casual: null, network: null },
            raw: "{}",
            ...overrides,
        },
        OWNER,
    );
    await fake.flush();
    return fake;
}

const shown = (fake: Awaited<ReturnType<typeof open>>) => JSON.stringify(fake.lastPayload());

test("the first page shows the verdict, parser and server link, with a Join button", async () => {
    const payload = shown(await open("🌀 WINDY Biome Started"));
    expect(payload).toContain("✅ Biome start");
    expect(payload).toContain("**Parser:** `multiscope`");
    expect(payload).toContain("**Server link:** `https://www.roblox.com/share?code=secret123");
    expect(payload).toContain("Join server");
});

test("the Find page shows the event, the session and what the member got", async () => {
    const at = new Date(1_000_000);
    const recorded = { id: 5, biome: "WINDY", macro_type: "multiscope", event_type: null, received_at: at };
    const record = {
        session: { id: 9, user_id: 1, started_at: at, ended_at: at, duration_seconds: 60, counted: true },
        reward: { event_id: 5, user_id: 1, biome: "WINDY", seeds_awarded: 3, xp_awarded: 4, badge_awarded: null, awarded_at: at },
        vote: null,
        casual: null,
        network: null,
    };
    const fake = await open("x", { recorded, record });
    await fake.emit(fake.click("tab:find", OWNER));
    const payload = shown(fake);
    expect(payload).toContain("**Event:** `#5` `WINDY` (no event type)");
    expect(payload).toContain("**Session:** `#9`");
    expect(payload).toContain("**Seeds:** 3");
});

test("the Votes page shows the vote result, or that there is none", async () => {
    const row = { id: "abc", guild_id: "1", channel_id: "2", message_id: "3", status: "admin_denied", decided_by: "8" };
    const record = {
        session: null,
        reward: null,
        vote: { row: row as never, tally: { real: 2, fake: 5 } },
        casual: null,
        network: null,
    };
    const fake = await open("x", { record });
    await fake.emit(fake.click("tab:votes", OWNER));
    const payload = shown(fake);
    expect(payload).toContain("`abc` admin denied");
    expect(payload).toContain("✅ 2 real, ❌ 5 fake");
    expect(payload).toContain("**Decided by:** <@8>");
    expect(payload).toContain("Not sent to the Network");
});

test("Texts read lists what the parser looked at", async () => {
    const fake = await open("📊 Status Update");
    await fake.emit(fake.click("tab:texts", OWNER));
    const payload = shown(fake);
    expect(payload).toContain("**title** ❌ no match");
    expect(payload).toContain("code=secret123");
});

test("a merchant report shows its own pages, with the session and without biome groups", async () => {
    const at = new Date(1_000_000);
    const record = {
        session: { id: 9, user_id: 1, started_at: at, ended_at: at, duration_seconds: 60, counted: true },
        reward: null,
        vote: null,
        casual: null,
        network: null,
    };
    const inspection = inspectMessage({ webhookId: "w", embeds: [{ description: "> ## Mari has arrived!" }] });
    const fake = await open("x", { inspection, record });
    expect(shown(fake)).toContain("**Merchant:** `Mari`");

    await fake.emit(fake.click("tab:find", OWNER));
    expect(shown(fake)).toContain("No merchant stored");
    expect(shown(fake)).toContain("**Session:** `#9`");
    expect(shown(fake)).not.toContain("No biome event stored");
    expect(shown(fake)).not.toContain("Given to the member");

    await fake.emit(fake.click("tab:votes", OWNER));
    expect(shown(fake)).toContain("No casual vote");
    expect(shown(fake)).not.toContain("Network");
});

test("a message reference is a link, or an id in the current channel", () => {
    const id = "1575480119227846751";
    expect(parseMessageReference("https://ptb.discord.com/channels/1/2/3", "9")).toEqual({ channelId: "2", messageId: "3" });
    expect(parseMessageReference(id, "9")).toEqual({ channelId: "9", messageId: id });
    expect(parseMessageReference("nope", "9")).toBeNull();
});

test("with nothing typed the replied-to message is used, and typed input wins over it", async () => {
    const fetched: string[] = [];
    const client = {
        channels: {
            fetch: async (channelId: string) => ({
                isTextBased: () => true,
                messages: {
                    fetch: async (messageId: string) => {
                        fetched.push(`${channelId}/${messageId}`);
                        return {};
                    },
                },
            }),
        },
    } as unknown as Parameters<typeof fetchReferencedMessage>[0];
    const replied = { channelId: "4", messageId: "5" };

    await fetchReferencedMessage(client, null, "9", replied);
    await fetchReferencedMessage(client, "https://discord.com/channels/1/2/3", "9", replied);
    expect(fetched).toEqual(["4/5", "2/3"]);
    await expect(fetchReferencedMessage(client, null, "9")).rejects.toThrow("Reply to a message");
});
