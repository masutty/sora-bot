import { afterEach, expect, test } from "bun:test";
import type { Client, Message } from "discord.js";
import { formatBiomeName, resolveBiomeSelector } from "../constants/biomes.constants";
import { getAllMerchants, type MerchantEntry, resetMerchantRegistry, setMerchantRegistry } from "../constants/merchants.constants";
import { inspectMessage } from "../macro-parsers";
import type { EmbedLike } from "../macro-parsers/types";
import { casualVoteCard } from "./casual-vote.service";
import { type DelayedForwardDeps, type ForwardServiceDeps, forwardBiome, sendDelayedForward } from "./forward.service";
import { recordMerchantFind } from "./merchant.service";
import { addMerchant, editMerchant, type MerchantAdminDeps, NO_MERCHANT_CHANGES } from "./merchant-admin.service";

afterEach(() => resetMerchantRegistry());

const LINK = "https://www.roblox.com/share?code=abc&type=Server";
const join = { name: "Private server", value: `[Join](${LINK})` };
const read = (embed: EmbedLike) => inspectMessage({ webhookId: "w", embeds: [embed] });
const mmacro = (kind: "Merchant" | "Biome", embed: EmbedLike) => ({ author: { name: `MMacro · ${kind}` }, ...embed });

test("MMacro's arrival and item list are the same merchant, and only the arrival has the link", () => {
    for (const merchant of ["Jester", "Rin", "Mari"]) {
        const arrival = read(mmacro("Merchant", { title: `Merchant Arrived - ${merchant}`, description: "Found <t:1:R>", fields: [join] }));
        expect(arrival).toMatchObject({
            parserId: "mmacro",
            event: null,
            serverLink: LINK,
            checkpoint: { kind: "merchant", merchant: merchant.toUpperCase() },
        });
    }
    const items = read(
        mmacro("Merchant", {
            title: "Merchant Items - Jester",
            fields: [
                { name: "Item list", value: "Rune of Wind, Heavenly Potion" },
                { name: "Bought", value: "Heavenly Potion x1" },
                { name: "", value: "-# [Join Manas Biome Support/Hunt Server](https://discord.gg/oppression)" },
            ],
        }),
    );
    expect(items).toMatchObject({ serverLink: null, checkpoint: { merchant: "JESTER" } });
});

test("MMacro biomes are read as biomes, not merchants", () => {
    const biome = read(mmacro("Biome", { title: "Biome Started - Windy", fields: [join, { name: "Running", value: "4h 36m" }] }));
    expect(biome).toMatchObject({ parserId: "mmacro", event: { biome: "WINDY", eventType: "started" }, checkpoint: null });
});

test("a Coteab arrival names the merchant", () => {
    const coteab = read({ description: "> ## **Mari** has arrived!", footer: { text: "Coteab Macro v2.2.1" } });
    expect(coteab.checkpoint?.merchant).toBe("MARI");
});

test("a merchant name on its own is macro time, never a recorded merchant", () => {
    expect(read({ title: "Jester settings" }).checkpoint).toMatchObject({ kind: "merchant", merchant: null });
    expect(read({ title: "Status", description: "**Account:** `rin`" }).checkpoint).toBeNull();
});

test("a duplicate arrival is not forwarded again", async () => {
    const forwarded: string[] = [];
    const ids = [7, null];
    const deps = {
        insertMerchantEventIfNew: async () => ids.shift() ?? null,
        checkAndForward: async (_m: unknown, _g: string, _u: number, parsed: { biome: string | null }) =>
            void forwarded.push(parsed.biome ?? ""),
    };
    const find = { userId: 1, merchant: "JESTER", macroType: "mmacro", serverLink: null };
    await recordMerchantFind({ id: "m1" } as Message, "g", find, deps);
    await recordMerchantFind({ id: "m2" } as Message, "g", find, deps);
    expect(forwarded).toEqual(["merchant:JESTER"]);
});

test("a merchant forward gets a casual vote, and a click redraws it as that merchant", async () => {
    const casual: Array<{ biome: string }> = [];
    let rareVotes = 0;
    const sent: unknown[] = [];
    const deps: ForwardServiceDeps = {
        getForwardConfig: async (_g, biome) => ({ guild_id: "g", biome, channel_id: "c", role_id: "r" }),
        getDelayedForwardConfig: async () => null,
        getBiomeCountForUser: async () => 3,
        getGuildBiomeFindStats: async () => ({ count: 41, lastFoundAt: null }),
        getUserById: async () => ({ discord_user_id: "finder" }) as never,
        newVoteId: () => "vote0001",
        openVote: async () => void rareVotes++ as never,
        openCasualVote: async (params) => {
            casual.push(params);
            return params as never;
        },
        voteWindowMs: async () => 1,
        scheduleDelayedForward: () => {},
        log: async () => {},
    };
    const channel = {
        isDMBased: () => false,
        isTextBased: () => true,
        send: async (payload: unknown) => {
            sent.push(payload);
            return { id: "s", channelId: "c" };
        },
    };
    const client = { channels: { fetch: async () => channel } } as unknown as Client;

    const parsed = {
        biome: "merchant:JESTER",
        macroType: "mmacro",
        eventType: "started" as const,
        eventTimestamp: null,
        serverLink: LINK,
    };
    await forwardBiome(client, "g", 1, parsed, 5, "https://discord.com/channels/1/2/3", deps);

    expect(rareVotes).toBe(0);
    expect(casual.map((c) => c.biome)).toEqual(["merchant:JESTER"]);
    expect(JSON.stringify(sent)).toContain("Jes");
    expect(JSON.stringify(sent)).not.toContain("merchant:");

    const redrawn = JSON.stringify(
        casualVoteCard({ id: "v", biome: "merchant:JESTER", jump_link: "https://discord.com/channels/1/2/3" } as never, {
            real: 1,
            fake: 0,
        }).toJSON(),
    );
    expect(redrawn).toContain("Jes");
    expect(redrawn).not.toContain("merchant:");
});

test("a delayed merchant forward asks the merchant finds whether it still exists", async () => {
    const asked: Array<[number, string]> = [];
    const deps: DelayedForwardDeps = {
        eventExists: async (id, target) => {
            asked.push([id, target]);
            return false;
        },
        getVoteById: async () => null,
        schedule: () => {},
        log: async () => {},
    };
    await sendDelayedForward({ eventId: 5, voteId: null, biome: "merchant:RIN", guildId: "g" } as never, deps);
    expect(asked).toEqual([[5, "merchant:RIN"]]);
});

test("All biomes never includes a merchant", () => {
    expect(resolveBiomeSelector("ALL").some((key) => key.includes(":"))).toBe(false);
    expect(formatBiomeName("merchant:RIN")).toBe("Rin");
});

function adminDeps(): MerchantAdminDeps {
    const rows = new Map(getAllMerchants().map((m) => [m.key, m]));
    return {
        insertMerchant: async (key, meta) => {
            if (rows.has(key)) return false;
            rows.set(key, { ...meta, key, enabled: true });
            return true;
        },
        updateMerchant: async (key, meta) => void rows.set(key, { ...(rows.get(key) as MerchantEntry), ...meta }),
        setMerchantEnabled: async () => {},
        reloadRegistry: async () => setMerchantRegistry([...rows.values()]),
    };
}

test("the owner can set a merchant's image, clear it, and add a merchant that is then read", async () => {
    const deps = adminDeps();
    await editMerchant("jester", { ...NO_MERCHANT_CHANGES, iconUrl: "https://example.com/j.png" }, deps);
    expect(getAllMerchants().find((m) => m.key === "JESTER")?.iconUrl).toBe("https://example.com/j.png");
    await editMerchant("JESTER", { ...NO_MERCHANT_CHANGES, iconUrl: "none" }, deps);
    expect(getAllMerchants().find((m) => m.key === "JESTER")?.iconUrl).toBeUndefined();
    await expect(editMerchant("JESTER", { ...NO_MERCHANT_CHANGES, iconUrl: "http://x" }, deps)).rejects.toThrow("https://");

    await addMerchant({ ...NO_MERCHANT_CHANGES, name: "Stella", color: "ff00ff" }, deps);
    expect(read({ title: "Merchant Arrived - Stella" }).checkpoint?.merchant).toBe("STELLA");
});
