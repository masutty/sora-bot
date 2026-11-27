import { expect, test } from "bun:test";
import type { BotClient } from "@/core/bot-client";
import type { PauseRow } from "../repository/pauses.repository";
import type { UserMacroChannelRow, UserRow } from "../types";
import { type PauseNoticeDeps, sendPauseNotice, sendPauseReminder } from "./pause-notice.service";

const pause = {
    id: 7,
    user_id: 3,
    message: "Please stop.",
    notice_sent_at: null,
    counts: false,
    dismissable: true,
    until: { kind: "interaction" },
} as PauseRow;
const client = {} as BotClient;

function setup(over: Partial<PauseNoticeDeps> = {}) {
    const sent: Array<{ channelId: string; payload: { allowedMentions?: unknown } }> = [];
    const marked: number[] = [];
    const logs: Array<{ guildId: string; entry: { kind: string; dedupKey?: string } }> = [];
    const deps: PauseNoticeDeps = {
        getUserById: async () => ({ id: 3, guild_id: "g1", discord_user_id: "d1" }) as UserRow,
        getMacroChannel: async () => ({ channel_id: "c1" }) as UserMacroChannelRow,
        send: async (channelId, payload) => {
            sent.push({ channelId, payload });
            return { id: "m1" };
        },
        markNoticeSent: async (id) => {
            marked.push(id);
        },
        guildLog: async (_client, guildId, entry) => {
            logs.push({ guildId, entry });
        },
        ...over,
    };
    return { deps, sent, marked, logs };
}

test("sendPauseNotice: posts in the Macro Channel, pings the member and marks it sent", async () => {
    const { deps, sent, marked, logs } = setup();
    expect(await sendPauseNotice(client, 3, pause, deps)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe("c1");
    expect(sent[0]?.payload.allowedMentions).toEqual({ users: ["d1"] });
    expect(marked).toEqual([7]);
    expect(logs).toEqual([]);
});

test("sendPauseNotice: a failed send returns false, logs one warning and never throws", async () => {
    const { deps, marked, logs } = setup({
        send: async () => {
            throw Object.assign(new Error("x"), { code: 10003 });
        },
    });
    expect(await sendPauseNotice(client, 3, pause, deps)).toBe(false);
    expect(marked).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.guildId).toBe("g1");
    expect(logs[0]?.entry.kind).toBe("warning");
    expect(logs[0]?.entry.dedupKey).toBeTruthy();
});

test("sendPauseNotice: no Macro Channel, or a legacy pause with no message, sends nothing", async () => {
    const noChannel = setup({ getMacroChannel: async () => null });
    expect(await sendPauseNotice(client, 3, pause, noChannel.deps)).toBe(false);
    expect(noChannel.logs).toHaveLength(1);
    const legacy = setup();
    expect(await sendPauseNotice(client, 3, { ...pause, message: null }, legacy.deps)).toBe(false);
    expect(legacy.sent).toEqual([]);
    expect(legacy.logs).toEqual([]);
});

test("the Notice says what the pause does, with the buttons under the container", async () => {
    const { deps, sent } = setup();
    await sendPauseNotice(client, 3, pause, deps);
    const payload = JSON.stringify(sent[0]?.payload);
    expect(payload).toContain("paused until you respond");
    expect(payload).toContain("None of your contributions will count");
    expect((sent[0]?.payload as { components?: unknown[] }).components).toHaveLength(2);

    const counting = setup();
    await sendPauseNotice(client, 3, { ...pause, counts: true, dismissable: false }, counting.deps);
    expect(JSON.stringify(counting.sent[0]?.payload)).not.toContain("None of your contributions");
    expect(JSON.stringify(counting.sent[0]?.payload)).not.toContain("Dismiss");
});

test("the reminder links to the Notice", async () => {
    const { deps, sent } = setup();
    await sendPauseReminder(client, 3, { ...pause, notice_channel_id: "c1", notice_message_id: "m1" }, deps);
    const payload = JSON.stringify(sent[0]?.payload);
    expect(payload).toContain("You have a pending notification");
    expect(payload).toContain("https://discord.com/channels/g1/c1/m1");
});
