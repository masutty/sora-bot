import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import { Logger } from "@/utils/logging";
import { answerOrphanClick, hasLiveView, markViewClosed, markViewListening, type OrphanClick } from "./orphan-click";

let logInfo: ReturnType<typeof spyOn>;
let logWarn: ReturnType<typeof spyOn>;

beforeEach(() => {
    logInfo = spyOn(Logger.prototype, "info").mockImplementation(() => {});
    logWarn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
    logInfo.mockRestore();
    logWarn.mockRestore();
});

function orphan(components: unknown[], opts: { updateFails?: boolean } = {}) {
    const calls: Array<[string, unknown]> = [];
    const rec = (name: string) => async (body: unknown) => {
        if (name === "update" && opts.updateFails) throw new Error("Invalid Form Body");
        calls.push([name, body]);
    };
    const i = { customId: "v:1:k", message: { components }, update: rec("update"), reply: rec("reply"), followUp: rec("followUp") };
    return { i: i as unknown as OrphanClick, calls };
}

const text = { type: ComponentType.TextDisplay, content: "Stats" };
const row = {
    type: ComponentType.ActionRow,
    components: [
        { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "v:1:back", label: "Back" },
        { type: ComponentType.Button, style: ButtonStyle.Link, url: "https://example.com", label: "Docs" },
    ],
};

test("a dead menu click strips the dead controls (Link buttons stay) and says the menu expired", async () => {
    const { i, calls } = orphan([text, row]);

    await answerOrphanClick(i);

    expect(calls.map(([name]) => name)).toEqual(["update", "followUp"]);
    expect(calls[0][1]).toEqual({ components: [text, { ...row, components: [row.components[1]] }] });
    expect(calls[1][1]).toMatchObject({ flags: MessageFlags.Ephemeral, content: expect.stringContaining("expired") });
});

test("a dead menu click Discord won't let us edit still gets the note, as a reply", async () => {
    const { i, calls } = orphan([row], { updateFails: true });

    await answerOrphanClick(i);

    expect(calls.map(([name]) => name)).toEqual(["reply"]);
    expect(calls[0][1]).toMatchObject({ flags: MessageFlags.Ephemeral });
});

test("a message stays live until every View listening on it closed", () => {
    markViewListening("m-live");
    markViewListening("m-live");
    markViewClosed("m-live");
    expect(hasLiveView("m-live")).toBe(true);
    markViewClosed("m-live");
    expect(hasLiveView("m-live")).toBe(false);
});
