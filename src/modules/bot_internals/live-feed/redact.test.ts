import { describe, expect, test } from "bun:test";
import { defaultLiteralSecrets, redact } from "./redact";

const MASK = "████████";
// Fake token, joined at runtime so GitHub's secret scanner doesn't flag the literal.
const fakeToken = (tail: string) => ["MTIzNDU2Nzg5MDEyMzQ1Njc4OQ", "GaBcDe", tail].join(".");

describe("redact", () => {
    test("masks literal secrets and skips short ones", () => {
        expect(redact("x hunter2pass y", ["hunter2pass"])).toBe(`x ${MASK} y`);
        expect(redact("x abc y", ["abc"])).toBe("x abc y");
        expect(redact("x pw123 y", ["pw123"])).toBe(`x ${MASK} y`);
        expect(redact("aXb+c(d)e", ["a.b+c(d)e"])).toBe("aXb+c(d)e");
        expect(redact("p a.b+c(d)e q", ["a.b+c(d)e"])).toBe(`p ${MASK} q`);
    });

    test("masks webhook URLs entirely", () => {
        expect(redact("https://discord.com/api/webhooks/123456789012345678/abcDEF-123", [])).toBe(MASK);
    });

    test("masks credentialed connection strings", () => {
        expect(redact("postgres://bot:s3cr3t@db:5432/sora", [])).toBe(MASK);
    });

    test("masks bot tokens", () => {
        expect(redact(fakeToken("abcdefghijklmnopqrstuvwxyz01234"), [])).toBe(MASK);
    });

    test("masks CLI-style flags with a leading separator", () => {
        expect(redact("--password=hunter2", [])).toBe(`--password=${MASK}`);
        expect(redact("__token=abc", [])).toBe(`__token=${MASK}`);
        expect(redact("monkey=banana", [])).toBe("monkey=banana");
        expect(redact("foo__token=abc", [])).toBe(`foo__token=${MASK}`);
        expect(redact("foo--password=abc", [])).toBe(`foo--password=${MASK}`);
        expect(redact("app_-secret=abc", [])).toBe(`app_-secret=${MASK}`);
    });

    test("long separator-heavy runs redact in linear time", () => {
        for (const text of ["a-".repeat(8192), "a_".repeat(8192), "a".repeat(16384)]) {
            const started = performance.now();
            redact(text, []);
            // Was ~800 ms (quadratic); now a few ms. The bound is generous to stay stable.
            expect(performance.now() - started).toBeLessThan(100);
        }
    });

    test("masks a bot token truncated at the capture cut", () => {
        expect(redact(fakeToken("abcdefghij"), [])).toBe(MASK);
    });

    test("masks a literal secret in its JSON-escaped form", () => {
        const out = redact('{"msg":"login with s3cr\\"et!"}', ['s3cr"et!']);
        expect(out).toBe(`{"msg":"login with ${MASK}"}`);
        expect(redact(String.raw`p ab\\cd q`, [String.raw`ab\cd`])).toBe(`p ${MASK} q`);
    });

    test("masks key/value secrets across JSON lines", () => {
        const out = redact('{\n  "password": "abc123",\n  "user": "x"\n}', []);
        expect(out).toContain(`"password": "${MASK}"`);
        expect(out).toContain('"user": "x"');
        expect(redact("?token=abc&x=1", [])).toBe(`?token=${MASK}&x=1`);
        expect(redact("monkey=banana", [])).toBe("monkey=banana");
    });

    test("masks bearer values", () => {
        expect(redact("Bearer abc.def", [])).toBe(`Bearer ${MASK}`);
    });

    test("partially masks snowflakes", () => {
        expect(redact("188851299255713792", [])).toBe("1888████3792");
        expect(redact("1234567890123456", [])).toBe("1234567890123456");
    });

    test("partially masks IPv4 and leaves timestamps alone", () => {
        expect(redact("192.168.0.10", [])).toBe("192.███.███.██");
        expect(redact("2026-10-21 12:00:00", [])).toBe("2026-10-21 12:00:00");
    });

    test("masks compound key names", () => {
        expect(redact("DB_PASSWORD=x1y2z3", [])).toBe(`DB_PASSWORD=${MASK}`);
        expect(redact("DISCORD_TOKEN=abc", [])).toBe(`DISCORD_TOKEN=${MASK}`);
        expect(redact('"access_token":"abc"', [])).toBe(`"access_token":"${MASK}"`);
        expect(redact("client_secret: abc", [])).toBe(`client_secret: ${MASK}`);
        expect(redact("API_KEY=abc", [])).toBe(`API_KEY=${MASK}`);
        expect(redact("accessToken=abc", [])).toBe(`accessToken=${MASK}`);
        expect(redact("monkey=banana", [])).toBe("monkey=banana");
    });

    test("masks quoted values containing spaces", () => {
        expect(redact('"password": "my pass phrase"', [])).toBe(`"password": "${MASK}"`);
        expect(redact("pwd='a b c' next", [])).toBe(`pwd='${MASK}' next`);
    });

    test("masks connection strings with empty users and slashes in passwords", () => {
        expect(redact("redis://:secret@host:6379", [])).toBe(MASK);
        expect(redact("postgres://u:pa/ss@h/db", [])).toBe(MASK);
    });

    test("masks authorization, cookie and Basic credentials", () => {
        expect(redact("authorization: abc", [])).toBe(`authorization: ${MASK}`);
        expect(redact("cookie=sid123", [])).toBe(`cookie=${MASK}`);
        expect(redact("Authorization: Basic dXNlcjpwYXNz", [])).not.toContain("dXNlcjpwYXNz");
        expect(redact("Basic dXNlcjpwYXNz", [])).toBe(`Basic ${MASK}`);
    });

    test("masks the rest of the line for authorization and cookie headers", () => {
        expect(redact("Cookie: sid=abc; other=def", [])).toBe(`Cookie: ${MASK}`);
        expect(redact("Set-Cookie: sid=abc; Path=/", [])).toBe(`Set-Cookie: ${MASK}`);
        expect(redact('Authorization: Digest user="a", response="zz"', [])).toBe(`Authorization: ${MASK}`);
        expect(redact("Authorization: Bearer x", [])).toBe(`Authorization: ${MASK}`);
    });

    test("masks quoted values with escaped quotes", () => {
        expect(redact(String.raw`{"password":"pa\"ss word"}`, [])).toBe(`{"password":"${MASK}"}`);
    });

    test("masks versioned webhook URLs and anything after the token", () => {
        const token = "a".repeat(68);
        expect(redact(`https://discord.com/api/v10/webhooks/123456789012345678/${token}`, [])).toBe(MASK);
        expect(redact(`x https://discord.com/api/webhooks/123456789012345678/${token}/messages/@original y`, [])).toBe(`x ${MASK} y`);
    });

    test("masks a bare webhook id and token", () => {
        expect(redact(`123456789012345678/${"b".repeat(68)}`, [])).toBe(MASK);
    });

    test("masks long hex runs", () => {
        expect(redact(`${"ab12".repeat(8)}:${"cd34".repeat(20)}`, [])).toBe(`${MASK}:${MASK}`);
        expect(redact("commit abcdef1 ok", [])).toBe("commit abcdef1 ok");
    });
});

describe("defaultLiteralSecrets", () => {
    test("includes ENCRYPTION_KEY and skips empty values", () => {
        const previous = process.env.ENCRYPTION_KEY;
        try {
            process.env.ENCRYPTION_KEY = "enc-key-for-test";
            expect(defaultLiteralSecrets()).toContain("enc-key-for-test");
            process.env.ENCRYPTION_KEY = "";
            expect(defaultLiteralSecrets()).not.toContain("");
        } finally {
            if (previous === undefined) delete process.env.ENCRYPTION_KEY;
            else process.env.ENCRYPTION_KEY = previous;
        }
    });
});
