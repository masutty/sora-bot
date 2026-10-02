import { expect, test } from "bun:test";
import { parsePrivateServerLink, privateServerCode } from "./network-link";

test("privateServerCode: a share link of type Server yields its code", () => {
    expect(privateServerCode("https://www.roblox.com/share?code=abc123DEF&type=Server")).toBe("abc123DEF");
    expect(privateServerCode("https://roblox.com/share?type=server&code=xyz")).toBe("xyz");
});

test("privateServerCode: a game link with privateServerLinkCode yields that code", () => {
    expect(privateServerCode("https://www.roblox.com/games/15532962292/Sols-RNG?privateServerLinkCode=12345678")).toBe("12345678");
});

test("privateServerCode: anything that does not lead to a private server is null", () => {
    expect(privateServerCode(null)).toBeNull();
    expect(privateServerCode("https://www.roblox.com/games/15532962292/Sols-RNG")).toBeNull();
    expect(privateServerCode("https://www.roblox.com/share?code=abc&type=ExperienceDetails")).toBeNull();
    expect(privateServerCode("https://roblox.com.evil.example/share?code=abc&type=Server")).toBeNull();
    expect(privateServerCode("http://www.roblox.com/share?code=abc&type=Server")).toBeNull();
    expect(privateServerCode("not a url")).toBeNull();
});

test("parsePrivateServerLink: rebuilds a clean link from the validated parts only", () => {
    expect(parsePrivateServerLink("https://www.roblox.com/share?code=abc_1-2&type=Server&x=*evil*")).toEqual({
        code: "abc_1-2",
        url: "https://www.roblox.com/share?code=abc_1-2&type=Server",
    });
    expect(parsePrivateServerLink("https://roblox.com/games/15532962292/Sols-RNG?privateServerLinkCode=123")).toEqual({
        code: "123",
        url: "https://www.roblox.com/games/15532962292?privateServerLinkCode=123",
    });
});

test("parsePrivateServerLink: a code or place id with markdown or odd characters is refused", () => {
    expect(parsePrivateServerLink("https://www.roblox.com/share?code=a*b)&type=Server")).toBeNull();
    expect(parsePrivateServerLink("https://www.roblox.com/games/12)3/x?privateServerLinkCode=1")).toBeNull();
    expect(parsePrivateServerLink(`https://www.roblox.com/share?code=${"a".repeat(129)}&type=Server`)).toBeNull();
});
