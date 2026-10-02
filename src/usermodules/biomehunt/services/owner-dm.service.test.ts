import { expect, test } from "bun:test";
import type { Client, MessageCreateOptions } from "discord.js";
import { notifyOwners } from "./owner-dm.service";

test("notifyOwners: a failed DM is skipped and the other owners still get it", async () => {
    const sent: string[] = [];
    const client = {
        users: {
            fetch: async (id: string) => {
                if (id === "closed") throw new Error("Cannot send messages to this user");
                return { send: async () => sent.push(id) };
            },
        },
    } as unknown as Client;

    await notifyOwners(client, { content: "hi" } as MessageCreateOptions, ["closed", "open"]);
    expect(sent).toEqual(["open"]);
});
