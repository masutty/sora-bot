import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { type OwnerDeps, ownerView } from "./owner.view";

const OWNER = "owner";

function text(p: ViewPayload): string {
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") return;
        const json = typeof (node as { toJSON?: unknown }).toJSON === "function" ? (node as { toJSON(): unknown }).toJSON() : node;
        if (Array.isArray(json)) return void json.forEach(walk);
        const obj = json as Record<string, unknown>;
        if (typeof obj.content === "string") out.push(obj.content);
        walk(obj.components);
    };
    walk(p.components);
    return out.join("\n");
}

const G1 = "111111111111111111";
const G2 = "222222222222222222";
const G3 = "333333333333333333";

function setup() {
    const calls: unknown[][] = [];
    const data = { def: 5, overrides: { [G2]: 9 } as Record<string, number> };
    const deps: OwnerDeps = {
        limits: {
            getDefaultLimit: async () => data.def,
            setDefaultLimit: async (n) => {
                calls.push(["setDefaultLimit", n]);
                data.def = n;
            },
            setGuildLimit: async (id, n) => {
                calls.push(["setGuildLimit", id, n]);
                if (n === null) delete data.overrides[id];
                else data.overrides[id] = n;
            },
            listGuildLimits: async () => Object.entries(data.overrides).map(([guild_id, max_stickies]) => ({ guild_id, max_stickies })),
        },
        usage: async () => [
            { guild_id: G1, count: 3 },
            { guild_id: G2, count: 1 },
            { guild_id: G3, count: 2 },
        ],
        guildName: (id) => ({ [G1]: "Alpha", [G2]: "Beta" })[id] ?? null,
    };
    const fake = createFakeViewTransport();
    void fake.run(ownerView(deps), undefined, OWNER);
    return { fake, calls };
}

async function submit(fake: ReturnType<typeof setup>["fake"], key: string, values: Record<string, string>) {
    const ack = fake.modalSubmit(OWNER);
    fake.modalResult = async () => ({ values, ack });
    await fake.emit(fake.click(key, OWNER));
}

test("shows the default limit and the known guilds with usage", async () => {
    const { fake } = setup();
    await fake.flush();
    const t = text(fake.lastPayload());
    expect(t).toContain("**Sticky settings**");
    expect(t).toContain("Default limit: 5");
    expect(t).toContain("Alpha: 3/5");
    expect(t).toContain("Beta: 1/9 (custom)");
});

test("guilds the bot is not in are hidden", async () => {
    const { fake } = setup();
    await fake.flush();
    expect(text(fake.lastPayload())).not.toContain("2/");
});

test("a default limit of 0 is refused and nothing changes", async () => {
    const { fake, calls } = setup();
    await fake.flush();
    await submit(fake, "defaultLimit", { limit: "0" });
    expect(fake.notifies.at(-1)?.content).toBe("Use a number from 1 to 25.");
    expect(calls).toEqual([]);
    expect(text(fake.lastPayload())).toContain("Default limit: 5");
});

test("a valid default limit is saved", async () => {
    const { fake, calls } = setup();
    await fake.flush();
    await submit(fake, "defaultLimit", { limit: "8" });
    expect(calls).toEqual([["setDefaultLimit", 8]]);
    expect(text(fake.lastPayload())).toContain("Default limit: 8");
});

test("the guild limit sets an override", async () => {
    const { fake, calls } = setup();
    await fake.flush();
    await submit(fake, "guildLimit", { guild: G1, limit: "12" });
    expect(calls).toEqual([["setGuildLimit", G1, 12]]);
    expect(text(fake.lastPayload())).toContain("Alpha: 3/12 (custom)");
});

test("an empty limit clears the override", async () => {
    const { fake, calls } = setup();
    await fake.flush();
    await submit(fake, "guildLimit", { guild: G2, limit: "" });
    expect(calls).toEqual([["setGuildLimit", G2, null]]);
    expect(text(fake.lastPayload())).toContain("Beta: 1/5");
    expect(text(fake.lastPayload())).not.toContain("(custom)");
});

test("a server ID that is not a snowflake is refused", async () => {
    const { fake, calls } = setup();
    await fake.flush();
    await submit(fake, "guildLimit", { guild: "abc", limit: "3" });
    expect(fake.notifies.at(-1)?.content).toBe("That is not a server ID.");
    expect(calls).toEqual([]);
});
