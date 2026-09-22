import { readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import type { BotClient } from "@/core/BotClient";
import type { ConfirmPayload } from "@/utils/confirm";

const TESTS_DIR = join(__dirname, "tests");

/** Same payload shape `confirmAction`/`attachPagination` already use everywhere else (Container +
 * optionally a button row) - proven compatible with both `interaction.editReply()`/`message.reply()`
 * (the initial send) and `attachPagination`'s `render` (page flips), unlike discord.js's own
 * `MessageEditOptions`/`MessageReplyOptions`, which don't agree with each other on `flags`. */
export type TestPayload = ConfirmPayload;

/**
 * A single `!test <keyword>` preview - builds a real payload from fake/hardcoded data, so a
 * message/embed can be iterated on visually without triggering the real flow that normally
 * produces it (waiting for a session to end, an admin action, etc).
 *
 * Exactly one of `run`/`pages`:
 * - `run` - a single-payload preview (the common case).
 * - `pages` - several payloads previewed as pagination pages, one design/variant per page - for
 *   comparing candidate layouts side by side before picking one (see `tests/embed/user-session.ts`).
 */
export interface TestCase {
    /** One-line description shown in the `!test` picker and `!test list`. */
    description: string;
    run?(client: BotClient): Promise<TestPayload> | TestPayload;
    pages?(client: BotClient): Promise<TestPayload[]> | TestPayload[];
}

/** Runs whichever of `run`/`pages` a test case defines, always as a page array - `run` just becomes a single-page result. */
export async function resolveTestPages(testCase: TestCase, client: BotClient): Promise<TestPayload[]> {
    if (testCase.pages) return testCase.pages(client);
    if (testCase.run) return [await testCase.run(client)];
    return [];
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
}

/**
 * Discovers every test case under `tests/`, keyed by its path relative to that directory (no
 * extension, forward slashes regardless of OS) - e.g. `tests/embed/session-end.ts` becomes the
 * keyword `embed/session-end`. Re-walks the directory and re-requires every file on each call
 * (cheap, and this is a dev-only command) so `!test` always reflects what's on disk right now.
 */
export function loadTestCases(): Map<string, TestCase> {
    const cases = new Map<string, TestCase>();

    for (const file of walk(TESTS_DIR)) {
        const key = relative(TESTS_DIR, file).replace(/\.ts$/, "").split(sep).join("/");
        const modulePath = file.replace(/\.ts$/, "");
        delete require.cache[require.resolve(modulePath)];
        const imported = require(modulePath);
        const testCase: TestCase = imported.default ?? imported;
        if (!testCase || (typeof testCase.run !== "function" && typeof testCase.pages !== "function")) continue;
        cases.set(key, testCase);
    }

    return cases;
}
