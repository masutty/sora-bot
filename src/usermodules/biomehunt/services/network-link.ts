const ROBLOX_HOSTS = new Set(["roblox.com", "www.roblox.com"]);

/** Codes and place ids are plain tokens - anything else (markdown, brackets, spaces) is refused, never escaped. */
const CODE_RE = /^[\w-]{1,128}$/;
const PLACE_ID_RE = /^\d{1,20}$/;

export interface PrivateServerLink {
    /** The private server's identity - also what deduplication compares. */
    code: string;
    /** A clean link rebuilt from the validated parts only - the macro's own text never reaches another server. */
    url: string;
}

/**
 * The private server behind a macro's server link, or `null` if the link doesn't lead to one - the
 * Network only publishes finds you can actually join. Accepts the two shapes Roblox hands out
 * (https only): `roblox.com/share?code=…&type=Server` and `roblox.com/games/<placeId>/…?privateServerLinkCode=…`.
 */
export function parsePrivateServerLink(link: string | null): PrivateServerLink | null {
    if (!link) return null;
    let url: URL;
    try {
        url = new URL(link);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || !ROBLOX_HOSTS.has(url.hostname.toLowerCase())) return null;

    if (url.pathname === "/share") {
        const code = url.searchParams.get("code");
        if (!code || !CODE_RE.test(code) || url.searchParams.get("type")?.toLowerCase() !== "server") return null;
        return { code, url: `https://www.roblox.com/share?code=${code}&type=Server` };
    }

    const placeId = url.pathname.split("/")[2];
    const code = url.searchParams.get("privateServerLinkCode");
    if (url.pathname.startsWith("/games/") && placeId && PLACE_ID_RE.test(placeId) && code && CODE_RE.test(code)) {
        return { code, url: `https://www.roblox.com/games/${placeId}?privateServerLinkCode=${code}` };
    }
    return null;
}

/** Just the code of `parsePrivateServerLink`. */
export function privateServerCode(link: string | null): string | null {
    return parsePrivateServerLink(link)?.code ?? null;
}
