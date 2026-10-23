import { beforeEach, expect, test } from "bun:test";
import { clearLogDedup, type GuildLogDeps, guildLog, sendLogTest } from "./guild-log.service";

const GUILD = "g1";

type Sent = { channelId: string; payload: { components: unknown[]; allowedMentions?: unknown } };

function fakeDeps(opts: { channelId?: string | null; failSend?: boolean } = {}) {
    const sent: Sent[] = [];
    const deps: GuildLogDeps = {
        getLogChannelId: async () => (opts.channelId === undefined ? "c1" : opts.channelId),
        send: async (channelId, payload) => {
            if (opts.failSend) throw new Error("Missing Access");
            sent.push({ channelId, payload: payload as Sent["payload"] });
        },
    };
    return { deps, sent };
}

const json = (s: Sent) => JSON.stringify((s.payload.components[0] as { toJSON(): unknown }).toJSON());

beforeEach(() => clearLogDedup(GUILD, "k"));

test("posts a warning with yellow accent and no pings", async () => {
    const { deps, sent } = fakeDeps();
    await guildLog({} as never, GUILD, { kind: "warning", title: "Forward failed", body: "No access.", footer: "ref abc" }, deps);
    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe("c1");
    expect(sent[0].payload.allowedMentions).toEqual({ parse: [] });
    const out = json(sent[0]);
    expect(out).toContain(`"accent_color":${0xf0b232}`);
    expect(out).toContain("**Forward failed**\\nNo access.");
    expect(out).toContain("-# ref abc");
});

test("uses the red accent and a generated ref for errors", async () => {
    const { deps, sent } = fakeDeps();
    await guildLog({} as never, GUILD, { kind: "error", title: "T", body: "B" }, deps);
    const out = json(sent[0]);
    expect(out).toContain(`"accent_color":${0xda373c}`);
    expect(out).toMatch(/-# ref `[0-9a-z]{8}`/);
});

test("dedups the same key until it is cleared", async () => {
    const { deps, sent } = fakeDeps();
    const entry = { kind: "warning", title: "T", body: "B", dedupKey: "k" } as const;
    await guildLog({} as never, GUILD, entry, deps);
    await guildLog({} as never, GUILD, entry, deps);
    expect(sent).toHaveLength(1);
    clearLogDedup(GUILD, "k");
    await guildLog({} as never, GUILD, entry, deps);
    expect(sent).toHaveLength(2);
});

test("does nothing without a log channel", async () => {
    const { deps, sent } = fakeDeps({ channelId: null });
    await guildLog({} as never, GUILD, { kind: "error", title: "T", body: "B", dedupKey: "k" }, deps);
    expect(sent).toHaveLength(0);
});

test("never throws when the post fails", async () => {
    const { deps } = fakeDeps({ failSend: true });
    await expect(guildLog({} as never, GUILD, { kind: "error", title: "T", body: "B" }, deps)).resolves.toBeUndefined();
});

test("a failed post does not mark the key as posted", async () => {
    const failing = fakeDeps({ failSend: true });
    const entry = { kind: "warning", title: "T", body: "B", dedupKey: "k" } as const;
    await guildLog({} as never, GUILD, entry, failing.deps);
    const ok = fakeDeps();
    await guildLog({} as never, GUILD, entry, ok.deps);
    expect(ok.sent).toHaveLength(1);
});

test("sendLogTest posts the test message and reports failures", async () => {
    const { deps, sent } = fakeDeps();
    expect(await sendLogTest({} as never, GUILD, deps)).toBe("Test posted in <#c1>.");
    expect(json(sent[0])).toContain("**🧪 Test**\\nLog posts will show up here.");
    await expect(sendLogTest({} as never, GUILD, fakeDeps({ failSend: true }).deps)).rejects.toThrow();
});
