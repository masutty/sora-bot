import { expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { option, panel } from "../views/panel.fixtures";
import { panelPickComponent } from "./panel-pick.component";

const options = [option(1, "General"), option(2, "Chat")];

function fakeInteraction(values: string[], guildId = "g1") {
    const calls: { kind: string; arg: unknown }[] = [];
    const interaction = {
        guildId,
        values,
        isStringSelectMenu: () => true,
        reply: async (arg: unknown) => void calls.push({ kind: "reply", arg }),
        update: async (arg: unknown) => void calls.push({ kind: "update", arg }),
        followUp: async (arg: unknown) => void calls.push({ kind: "followUp", arg }),
    };
    return { interaction, calls };
}

const handler = (found = panel()) =>
    panelPickComponent({ getPanel: async (id) => (id === found.id ? found : null), listOptions: async () => options });

test("from the root: the channel message goes back to its start and the page is a private follow-up", async () => {
    const { interaction, calls } = fakeInteraction(["2"]);
    await handler().handle(interaction as never, ["7", "root"], {} as never);
    expect(calls.map((c) => c.kind)).toEqual(["update", "followUp"]);
    const followUp = calls[1].arg as { flags: number; components: { toJSON(): unknown }[] };
    expect(followUp.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(followUp.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(JSON.stringify(followUp.components.map((c) => c.toJSON()))).toContain("## Chat");
});

test("from an option page: the same message is swapped in place, no new message", async () => {
    const { interaction, calls } = fakeInteraction(["1"]);
    await handler().handle(interaction as never, ["7", "eph"], {} as never);
    expect(calls.map((c) => c.kind)).toEqual(["update"]);
    expect(JSON.stringify((calls[0].arg as { components: { toJSON(): unknown }[] }).components.map((c) => c.toJSON()))).toContain(
        "## General",
    );
});

test("an option deleted after the panel was posted answers privately instead of throwing", async () => {
    const { interaction, calls } = fakeInteraction(["99"]);
    await handler().handle(interaction as never, ["7", "root"], {} as never);
    expect(calls).toEqual([{ kind: "reply", arg: { content: "This option no longer exists.", flags: MessageFlags.Ephemeral } }]);
});

test("a deleted panel, a bad id or another server's panel answer privately", async () => {
    for (const [parts, guild] of [
        [["8", "root"], "g1"],
        [["x", "root"], "g1"],
        [["7", "root"], "other"],
    ] as const) {
        const { interaction, calls } = fakeInteraction(["1"], guild);
        await handler().handle(interaction as never, [...parts], {} as never);
        expect(calls).toEqual([{ kind: "reply", arg: { content: "This panel no longer exists.", flags: MessageFlags.Ephemeral } }]);
    }
});
