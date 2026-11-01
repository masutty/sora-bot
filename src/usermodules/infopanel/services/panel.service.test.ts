import { beforeEach, expect, test } from "bun:test";
import type { OptionRow, PanelRow } from "../types";
import { option, panel } from "../views/panel.fixtures";
import { type Publisher, panelService as realPanelService } from "./panel.service";

let panels: Map<number, PanelRow>;
let options: OptionRow[];

const store = {
    getPanel: async (id: number) => panels.get(id) ?? null,
    listOptions: async (panelId: number) => options.filter((o) => o.panel_id === panelId),
    updatePanel: async (id: number, patch: Partial<PanelRow>) => {
        const row = panels.get(id);
        if (row) panels.set(id, { ...row, ...patch });
    },
    deletePanel: async (id: number) => void panels.delete(id),
};

const panelService = (publisher: Publisher) => realPanelService(publisher, store);

type Call = { kind: "send" | "edit" | "remove"; channelId: string; messageId?: string };

function fakePublisher(editResult: "ok" | "gone" = "ok") {
    const calls: Call[] = [];
    return {
        calls,
        publisher: {
            send: async (channelId: string) => {
                calls.push({ kind: "send", channelId });
                return "m-new";
            },
            edit: async (channelId: string, messageId: string) => {
                calls.push({ kind: "edit", channelId, messageId });
                return editResult;
            },
            remove: async (channelId: string, messageId: string) => void calls.push({ kind: "remove", channelId, messageId }),
        },
    };
}

beforeEach(() => {
    panels = new Map([[7, panel()]]);
    options = [option(1, "General")];
});

test("publish posts a new message and remembers where", async () => {
    const { calls, publisher } = fakePublisher();
    await panelService(publisher).publish(7, "c1");
    expect(calls).toEqual([{ kind: "send", channelId: "c1" }]);
    expect(panels.get(7)).toMatchObject({ channel_id: "c1", message_id: "m-new" });
});

test("publish with no options is refused", async () => {
    options = [];
    const { calls, publisher } = fakePublisher();
    await expect(panelService(publisher).publish(7, "c1")).rejects.toThrow("at least one option");
    expect(calls).toEqual([]);
});

test("publish again in the same channel edits the posted message", async () => {
    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    const { calls, publisher } = fakePublisher();
    await panelService(publisher).publish(7, "c1");
    expect(calls).toEqual([{ kind: "edit", channelId: "c1", messageId: "m1" }]);
});

test("publish again when the old message is gone posts a fresh one", async () => {
    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    const { calls, publisher } = fakePublisher("gone");
    await panelService(publisher).publish(7, "c1");
    expect(calls.map((c) => c.kind)).toEqual(["edit", "send"]);
    expect(panels.get(7)?.message_id).toBe("m-new");
});

test("publish in another channel posts there and removes the old message", async () => {
    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    const { calls, publisher } = fakePublisher();
    await panelService(publisher).publish(7, "c2");
    expect(calls).toEqual([
        { kind: "send", channelId: "c2" },
        { kind: "remove", channelId: "c1", messageId: "m1" },
    ]);
    expect(panels.get(7)).toMatchObject({ channel_id: "c2", message_id: "m-new" });
});

test("refresh edits the posted message and does nothing for a panel never posted", async () => {
    const never = fakePublisher();
    await panelService(never.publisher).refresh(7);
    expect(never.calls).toEqual([]);

    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    const posted = fakePublisher();
    await panelService(posted.publisher).refresh(7);
    expect(posted.calls).toEqual([{ kind: "edit", channelId: "c1", messageId: "m1" }]);
});

test("refresh forgets a message that was deleted, so the panel shows Not posted", async () => {
    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    await panelService(fakePublisher("gone").publisher).refresh(7);
    expect(panels.get(7)).toMatchObject({ channel_id: null, message_id: null });
});

test("remove deletes the posted message and the panel", async () => {
    panels.set(7, panel({ channel_id: "c1", message_id: "m1" }));
    const { calls, publisher } = fakePublisher();
    await panelService(publisher).remove(7);
    expect(calls).toEqual([{ kind: "remove", channelId: "c1", messageId: "m1" }]);
    expect(panels.has(7)).toBe(false);
});
