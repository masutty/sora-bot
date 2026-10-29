import { config } from "@/config";

const SECRET_MASK = "████████";
const MIN_LITERAL_LENGTH = 4;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const KEY_WORDS = ["token", "secret", "password", "passwd", "pwd", "apikey", "key"];
// Header-like keys carry multi-token values (`Cookie: a=b; c=d`), so an unquoted value runs to the end of the line.
const LINE_KEY_WORDS = ["authorization", "cookie"];
const DOUBLE_QUOTED = String.raw`("(?:[^"\\]|\\.)*")`;
const SINGLE_QUOTED = String.raw`('(?:[^'\\]|\\.)*')`;
const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);

// The key name may be compound: snake_case/kebab-case prefixes (DB_PASSWORD) or camelCase (accessToken).
// A bare lowercase "key" inside a word (monkey) must not match, so only separators or a capital start a keyword.
function keyValueRegex(words: readonly string[], bareValue: string): RegExp {
    const keyword = [`[a-z0-9]*(?:${words.map(capitalize).join("|")})`, words.join("|"), words.map((w) => w.toUpperCase()).join("|")].join(
        "|",
    );
    return new RegExp(
        String.raw`(?<![A-Za-z0-9_-])([_-]*(?:[A-Za-z0-9]+[_-]+)*(?:${keyword})["']?\s*[=:]\s*)(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${bareValue})`,
        "g",
    );
}

const KEY_VALUE = keyValueRegex(KEY_WORDS, String.raw`["']?[^\s"'&,]+`);
const LINE_KEY_VALUE = keyValueRegex(LINE_KEY_WORDS, String.raw`[^\r\n]+`);

function maskKeyValue(_match: string, head: string, doubleQuoted?: string, singleQuoted?: string): string {
    if (doubleQuoted !== undefined) return `${head}"${SECRET_MASK}"`;
    if (singleQuoted !== undefined) return `${head}'${SECRET_MASK}'`;
    return `${head}${SECRET_MASK}`;
}

// Applied in this order: earlier patterns swallow whole secrets so later ones cannot leave fragments behind.
const PATTERNS: readonly (readonly [RegExp, string | typeof maskKeyValue])[] = [
    [/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+(?:\/\S*)?/gi, SECRET_MASK],
    // A webhook id and token pasted without the URL.
    [/\b\d{17,20}\/[\w-]{60,}/g, SECRET_MASK],
    // The scheme is capped: unbounded, it was rescanned from every word of `a-a-a-...`, quadratically.
    [/\b[a-z][\w+.-]{0,31}:\/\/[^\s:@/]*:[^\s@]+@\S*/gi, SECRET_MASK],
    [/(?<![\w-])[\w-]{24,}\.[\w-]{6,7}\.[\w-]{10,}/g, SECRET_MASK],
    [/\bBearer\s+[\w.~+/-]+=*/g, `Bearer ${SECRET_MASK}`],
    [/\bBasic\s+[A-Za-z0-9+/]{8,}=*/g, `Basic ${SECRET_MASK}`],
    [LINE_KEY_VALUE, maskKeyValue],
    [KEY_VALUE, maskKeyValue],
    // Long hex runs, such as the stored encrypted webhook (`iv:hex`).
    [/\b[0-9a-fA-F]{32,}\b/g, SECRET_MASK],
    [/\b(\d{4})\d{9,12}(\d{4})\b/g, "$1████$2"],
    [/\b(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "$1.███.███.██"],
];

/** Masks secrets, snowflakes and IPv4 addresses so the feed is safe to post in a public channel. */
export function redact(text: string, literalSecrets: readonly string[]): string {
    let out = text;
    // Longest first, so a secret that contains another one is masked whole.
    const literals = literalSecrets.filter((s) => s.length >= MIN_LITERAL_LENGTH).sort((a, b) => b.length - a.length);
    for (const secret of literals) {
        out = out.replace(new RegExp(escapeRegExp(secret), "g"), SECRET_MASK);
        // Inside a JSON log line the same secret appears escaped (`\"`, `\\`).
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret) out = out.replace(new RegExp(escapeRegExp(escaped), "g"), SECRET_MASK);
    }
    for (const [pattern, replacement] of PATTERNS) {
        // Separate calls keep each `replace` overload happy for the string and function replacers.
        if (typeof replacement === "string") out = out.replace(pattern, replacement);
        else out = out.replace(pattern, replacement);
    }
    return out;
}

/** The bot's own credentials, masked verbatim wherever they appear. */
export function defaultLiteralSecrets(): string[] {
    return [config.discord.token, config.database.password, process.env.ENCRYPTION_KEY].filter((value): value is string => !!value);
}
