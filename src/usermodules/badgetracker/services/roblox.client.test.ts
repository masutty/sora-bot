import { describe, expect, test } from "bun:test";
import { createRobloxClient } from "./roblox.client";

type Call = { url: string; init?: RequestInit };

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fn = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return handler(url);
    }) as unknown as typeof fetch;
    return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

describe("fetchBadge", () => {
    test("fetches GET https://badges.roblox.com/v1/badges/{id} with the User-Agent header", async () => {
        const { fn, calls } = fakeFetch(() => json({ name: "n", description: "d", statistics: { awardedCount: 1 } }));
        await createRobloxClient(fn).fetchBadge("123");
        expect(calls[0]?.url).toBe("https://badges.roblox.com/v1/badges/123");
        expect((calls[0]?.init?.headers as Record<string, string>)["User-Agent"]).toBe("sora-bot badge-tracker");
        expect(calls[0]?.init?.signal).toBeDefined();
    });

    test("maps statistics.awardedCount, name and description", async () => {
        const { fn } = fakeFetch(() => json({ name: "Name", description: null, statistics: { awardedCount: 42 } }));
        expect(await createRobloxClient(fn).fetchBadge("7")).toEqual({
            kind: "ok",
            badge: { id: "7", name: "Name", description: "", awardedCount: 42 },
        });
        const { fn: fn2 } = fakeFetch(() => json({ name: "A", description: "Desc", statistics: { awardedCount: 3 } }));
        const r = await createRobloxClient(fn2).fetchBadge("8");
        expect(r.kind === "ok" && r.badge.description).toBe("Desc");
    });

    test("maps 404 and 400 to not_found", async () => {
        for (const status of [404, 400]) {
            const { fn } = fakeFetch(() => json({}, status));
            expect(await createRobloxClient(fn).fetchBadge("1")).toEqual({ kind: "not_found" });
        }
    });

    test("maps 429 with Retry-After: 12 to retryAfterMs 12000", async () => {
        const { fn } = fakeFetch(() => json({}, 429, { "Retry-After": "12" }));
        expect(await createRobloxClient(fn).fetchBadge("1")).toEqual({ kind: "rate_limited", retryAfterMs: 12000 });
    });

    test("maps 429 without Retry-After to retryAfterMs null", async () => {
        const { fn } = fakeFetch(() => json({}, 429));
        expect(await createRobloxClient(fn).fetchBadge("1")).toEqual({ kind: "rate_limited", retryAfterMs: null });
    });

    test("maps 500 to error", async () => {
        const { fn } = fakeFetch(() => json({}, 500));
        expect((await createRobloxClient(fn).fetchBadge("1")).kind).toBe("error");
    });

    test("treats a body without awardedCount as an error", async () => {
        const { fn } = fakeFetch(() => json({ name: "n", description: "d", statistics: {} }));
        expect((await createRobloxClient(fn).fetchBadge("1")).kind).toBe("error");
    });

    test("treats a non-JSON body as an error", async () => {
        const { fn } = fakeFetch(() => new Response("<html>", { status: 200 }));
        expect((await createRobloxClient(fn).fetchBadge("1")).kind).toBe("error");
    });

    test("maps a thrown fetch (timeout) to error", async () => {
        const { fn } = fakeFetch(() => {
            throw new Error("timed out");
        });
        expect(await createRobloxClient(fn).fetchBadge("1")).toEqual({ kind: "error", message: "timed out" });
    });
});

describe("fetchIcons", () => {
    const iconBody = (url: string) => {
        const ids = new URL(url).searchParams.get("badgeIds")?.split(",") ?? [];
        return json({ data: ids.map((id) => ({ targetId: Number(id), state: "Completed", imageUrl: `https://img/${id}` })) });
    };

    test("chunks 150 ids into requests of 100 and 50", async () => {
        const { fn, calls } = fakeFetch(iconBody);
        const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
        const icons = await createRobloxClient(fn).fetchIcons(ids);
        expect(calls).toHaveLength(2);
        expect(calls[0]?.url.startsWith("https://thumbnails.roblox.com/v1/badges/icons?badgeIds=")).toBe(true);
        expect(calls[0]?.url).toEndWith("&size=150x150&format=Png&isCircular=false");
        expect(new URL(calls[0]?.url ?? "").searchParams.get("badgeIds")?.split(",")).toHaveLength(100);
        expect(new URL(calls[1]?.url ?? "").searchParams.get("badgeIds")?.split(",")).toHaveLength(50);
        expect(icons.size).toBe(150);
        expect(icons.get("150")).toBe("https://img/150");
    });

    test('keeps only entries with state "Completed"', async () => {
        const { fn } = fakeFetch(() =>
            json({
                data: [
                    { targetId: 1, state: "Completed", imageUrl: "https://img/1" },
                    { targetId: 2, state: "Pending", imageUrl: "" },
                    { targetId: 3, state: "Blocked", imageUrl: "x" },
                ],
            }),
        );
        const icons = await createRobloxClient(fn).fetchIcons(["1", "2", "3"]);
        expect([...icons.entries()]).toEqual([["1", "https://img/1"]]);
    });

    test("returns what it got when a chunk fails", async () => {
        let n = 0;
        const { fn } = fakeFetch((url) => (n++ === 0 ? iconBody(url) : json({}, 500)));
        const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
        const icons = await createRobloxClient(fn).fetchIcons(ids);
        expect(icons.size).toBe(100);
    });

    test("returns an empty map for no ids without fetching", async () => {
        const { fn, calls } = fakeFetch(iconBody);
        expect((await createRobloxClient(fn).fetchIcons([])).size).toBe(0);
        expect(calls).toHaveLength(0);
    });
});
