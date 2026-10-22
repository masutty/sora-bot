import { Logger } from "@/utils/logging";
import { settings } from "../settings";
import type { RobloxBadge } from "../types";

const logger = new Logger("badge-tracker.roblox");

export type BadgeFetchResult =
    | { kind: "ok"; badge: RobloxBadge }
    | { kind: "not_found" }
    | { kind: "rate_limited"; retryAfterMs: number | null }
    | { kind: "error"; message: string };

export interface RobloxClient {
    fetchBadge(id: string): Promise<BadgeFetchResult>;
    fetchIcons(ids: string[]): Promise<Map<string, string>>;
}

function request(fetchFn: typeof fetch, url: string): Promise<Response> {
    return fetchFn(url, {
        method: "GET",
        headers: { "User-Agent": settings.roblox.userAgent },
        signal: AbortSignal.timeout(settings.roblox.timeoutMs),
    });
}

function parseRetryAfter(header: string | null): number | null {
    if (header === null) return null;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function createRobloxClient(fetchFn: typeof fetch = fetch): RobloxClient {
    async function fetchBadge(id: string): Promise<BadgeFetchResult> {
        try {
            const res = await request(fetchFn, `https://badges.roblox.com/v1/badges/${id}`);
            if (res.status === 404 || res.status === 400) return { kind: "not_found" };
            if (res.status === 429) {
                return { kind: "rate_limited", retryAfterMs: parseRetryAfter(res.headers.get("Retry-After")) };
            }
            if (!res.ok) return { kind: "error", message: `HTTP ${res.status}` };

            const body = (await res.json()) as {
                name?: unknown;
                description?: unknown;
                statistics?: { awardedCount?: unknown };
            };
            const awardedCount = body?.statistics?.awardedCount;
            if (typeof awardedCount !== "number") return { kind: "error", message: "missing awardedCount" };
            return {
                kind: "ok",
                badge: {
                    id,
                    name: typeof body.name === "string" ? body.name : "",
                    description: typeof body.description === "string" ? body.description : "",
                    awardedCount,
                },
            };
        } catch (err) {
            return { kind: "error", message: err instanceof Error ? err.message : String(err) };
        }
    }

    async function fetchIcons(ids: string[]): Promise<Map<string, string>> {
        const icons = new Map<string, string>();
        for (let i = 0; i < ids.length; i += settings.roblox.iconBatch) {
            const chunk = ids.slice(i, i + settings.roblox.iconBatch);
            const url = `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${chunk.join(",")}&size=150x150&format=Png&isCircular=false`;
            try {
                const res = await request(fetchFn, url);
                if (!res.ok) {
                    logger.warn("Icon batch failed", { status: res.status, size: chunk.length });
                    continue;
                }
                const body = (await res.json()) as {
                    data?: { targetId?: number; state?: string; imageUrl?: string }[];
                };
                for (const entry of body.data ?? []) {
                    if (entry.state === "Completed" && entry.targetId !== undefined && entry.imageUrl) {
                        icons.set(String(entry.targetId), entry.imageUrl);
                    }
                }
            } catch (err) {
                logger.warn("Icon batch threw", { error: err instanceof Error ? err.message : String(err), size: chunk.length });
            }
        }
        return icons;
    }

    return { fetchBadge, fetchIcons };
}
