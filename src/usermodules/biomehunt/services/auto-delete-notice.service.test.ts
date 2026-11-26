import { expect, test } from "bun:test";
import { ButtonStyle } from "discord.js";
import { NO_PINGS } from "@/utils/format";
import { type AutoDeleteNoticeDeps, buildAutoDeleteDm, notifyAutoDelete } from "./auto-delete-notice.service";

const target = { guildId: "g1", discordUserId: "u1", hardWipe: false };

test("buildAutoDeleteDm: channel-only embed, link button and no pings", () => {
    const p = buildAutoDeleteDm("Sora HQ", "g1", false);
    const embed = p.embeds[0].toJSON();
    expect(embed?.title).toBe("Your macro channel was deleted");
    expect(embed?.color).toBe(0xf0b232);
    expect(embed?.description).toBe("> **Reason:** Automatically deleted due to inactivity\n\n> Run `/bh setup` to get a new one.");
    const button = p.components[0].toJSON().components[0] as { label: string; url: string; style: number };
    expect(button.label).toBe("Sent from | Sora HQ");
    expect(button.url).toBe("https://discord.com/channels/g1");
    expect(button.style).toBe(ButtonStyle.Link);
    expect(p.allowedMentions).toEqual(NO_PINGS);
});

test("buildAutoDeleteDm: hard wipe embed", () => {
    const embed = buildAutoDeleteDm("Sora HQ", "g1", true).embeds[0].toJSON();
    expect(embed?.color).toBe(0xda373c);
    expect(embed?.description).toBe(
        "> **Reason:** Automatically deleted due to inactivity\n> Your badges, history and quota progress were cleared with it.\n\n> Run `/bh setup` to start over.",
    );
});

test("buildAutoDeleteDm: truncates the button label to 80 characters", () => {
    const p = buildAutoDeleteDm("x".repeat(200), "g1", false);
    const button = p.components[0].toJSON().components[0] as { label: string };
    expect(button.label).toHaveLength(80);
});

function setup(over: Partial<AutoDeleteNoticeDeps> = {}) {
    const dms: string[] = [];
    const logs: Array<{ guildId: string; entry: { kind: string; title: string; body: string } }> = [];
    const warns: string[] = [];
    const deps: AutoDeleteNoticeDeps = {
        sendDm: async (id) => {
            dms.push(id);
        },
        guildName: () => "Sora HQ",
        postGuildLog: async (guildId, entry) => {
            logs.push({ guildId, entry });
            return true;
        },
        log: (m) => warns.push(m),
        ...over,
    };
    return { deps, dms, logs, warns };
}

const boom = async () => {
    throw new Error("boom");
};

test("notifyAutoDelete: DM ok posts nothing to the guild log", async () => {
    const { deps, dms, logs } = setup();
    await notifyAutoDelete(target, deps);
    expect(dms).toEqual(["u1"]);
    expect(logs).toEqual([]);
});

test("notifyAutoDelete: DM failure posts the exact warning", async () => {
    const { deps, logs } = setup({ sendDm: boom });
    await notifyAutoDelete(target, deps);
    expect(logs).toEqual([
        {
            guildId: "g1",
            entry: {
                kind: "warning",
                title: "Auto-delete",
                body: "Deleted the macro channel of <@u1> for inactivity. I couldn't DM them.",
            },
        },
    ]);
});

test("notifyAutoDelete: DM failure and no log channel only logs", async () => {
    const { deps, warns } = setup({ sendDm: boom, postGuildLog: async () => false });
    await notifyAutoDelete(target, deps);
    expect(warns.length).toBeGreaterThan(1);
});

test("notifyAutoDelete: throwing deps never propagate", async () => {
    await notifyAutoDelete(target, setup({ sendDm: boom, postGuildLog: boom }).deps);
    await notifyAutoDelete(
        target,
        setup({
            guildName: () => {
                throw new Error("boom");
            },
        }).deps,
    );
    await notifyAutoDelete(
        target,
        setup({
            sendDm: boom,
            postGuildLog: boom,
            log: () => {
                throw new Error("boom");
            },
        }).deps,
    );
});
