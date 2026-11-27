import { expect, test } from "bun:test";
import { MessageFlags, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { BotClient } from "@/core/bot-client";
import type { PauseRow } from "../repository/pauses.repository";
import { type PauseNoticeComponentDeps, pauseNoticeComponent } from "./pause-notice.component";

const ended = { pause: { id: 7, message: "stop", until: { kind: "interaction" } } as PauseRow, discordUserId: "u1", guildId: "g" };

async function click(parts: string[], over: Partial<PauseNoticeComponentDeps> = {}, admin = false) {
    const calls: string[] = [];
    const sent: Array<{ how: string; payload: unknown }> = [];
    const record = (how: string) => async (payload: unknown) => void sent.push({ how, payload });
    const interaction = {
        user: { id: "u1" },
        message: { id: "notice" },
        memberPermissions: new PermissionsBitField(admin ? PermissionFlagsBits.Administrator : 0n),
        channel: { messages: { fetch: async (id: string) => ({ edit: record(`edit ${id}`) }) } },
        isButton: () => true,
        reply: record("reply"),
        update: record("update"),
    };
    const deps: PauseNoticeComponentDeps = {
        endPause: async () => {
            calls.push("end");
            return ended;
        },
        checkDismiss: async () => "ok",
        dismissPause: async () => {
            calls.push("dismiss");
            return ended;
        },
        cancelPause: async () => {
            calls.push("cancel");
            return ended;
        },
        reportDismissed: async () => void calls.push("report"),
        ...over,
    };
    await pauseNoticeComponent(deps).handle(interaction as never, parts, {} as BotClient);
    return { calls, sent, text: JSON.stringify(sent) };
}

test("Understood ends the pause and closes the Notice", async () => {
    const { calls, sent, text } = await click(["7"]);
    expect(calls).toEqual(["end"]);
    expect(sent.map((s) => s.how)).toEqual(["update"]);
    expect(text).toContain("Pause ended");
});

test("a refused Understood answers privately", async () => {
    for (const [result, message] of [
        ["not_owner", "not yours"],
        ["not_active", "no longer active"],
    ] as const) {
        const { sent, text } = await click(["7"], { endPause: async () => result });
        expect(sent[0]?.how).toBe("reply");
        expect((sent[0]?.payload as { flags: number }).flags).toBe(MessageFlags.Ephemeral);
        expect(text).toContain(message);
    }
});

test("Dismiss asks first; confirming ends the pause, tells the staff and closes the Notice", async () => {
    const ask = await click(["7", "dismiss"]);
    expect(ask.calls).toEqual([]);
    expect(ask.text).toContain("dismiss-confirm:notice");

    const confirm = await click(["7", "dismiss-confirm", "notice"]);
    expect(confirm.calls).toEqual(["dismiss", "report"]);
    expect(confirm.sent.map((s) => s.how)).toEqual(["update", "edit notice"]);

    const back = await click(["7", "dismiss-back"]);
    expect(back.calls).toEqual([]);
});

test("only an admin can cancel", async () => {
    const member = await click(["7", "cancel"]);
    expect(member.calls).toEqual([]);
    expect(member.text).toContain("Only an admin");

    const admin = await click(["7", "cancel"], {}, true);
    expect(admin.calls).toEqual(["cancel"]);
    expect(admin.text).toContain("Cancelled by <@u1>");
});

test("a malformed id ends nothing", async () => {
    const { calls, text } = await click(["x"]);
    expect(calls).toEqual([]);
    expect(text).toContain("no longer active");
});
