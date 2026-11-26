import { expect, test } from "bun:test";
import { createFakeViewTransport, type ViewPayload } from "@/define";
import { firstProjectFrame, pageLines, traceView } from "./trace.view";

const OWNER = "owner";
const l = (level: string, msg: string) => `2026-11-25 10:00:00 ${level.padEnd(7)} [ns] (ref=abc /bh balance u=me(1) g=2): ${msg}`;
const json = (p: ViewPayload) => JSON.stringify((p.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));

async function open(lines: string[]) {
    const fake = createFakeViewTransport();
    void fake.run(traceView(), { id: "abc", lines }, OWNER);
    await fake.flush();
    return fake;
}

const withError = [
    l("info", "invoked with user=`<@1>` reason=`spam`"),
    l("error", "boom"),
    "    at a (./src/svc/case.service.ts:244:9)",
    "    at b (./src/x.ts:2:1)",
    l("info", "after"),
    l("info", "error in 12ms"),
];

test("the summary lists who ran what, the arguments, the error and where it happened", async () => {
    const out = json((await open(withError)).lastPayload());
    expect(out).toContain("**Invocation**\\n- **Invoker:** <@1> (`me`)\\n- **Server:** `2`");
    expect(out).toContain("- **Took:** 12ms");
    expect(out).toContain("**Command**\\n- **Name:** `/bh balance` (slash)\\n- **Arguments:** `user=<@1>, reason=spam`");
    expect(out).toContain("**Error**\\n> boom\\n- **Where:** `src/svc/case.service.ts:244`");
    expect(out).toContain("-# Internal error");
    expect(out).toContain("-# 6 log lines");
    expect(out).toContain(":stack");
});

test("a trace without errors has no Stack trace button, Error group or Where line", async () => {
    const out = json((await open([l("info", "invoked with no arguments"), l("info", "ok in 5ms")])).lastPayload());
    expect(out).toContain("-# No error");
    expect(out).toContain("- **Arguments:** None");
    expect(out).not.toContain("**Error**");
    expect(out).not.toContain(":stack");
    expect(out).not.toContain("**Where:**");
    expect(out).toContain("-# 2 log lines");
    expect(out).toContain(":download");
});

test("groups without data are left out", async () => {
    const out = json((await open(["2026-11-25 10:00:00 info    [ns] (ref=abc): hello"])).lastPayload());
    expect(out).not.toContain("Arguments");
    expect(out).not.toContain("took");
    expect(out).not.toContain("by <@");
});

test("the first project frame skips node_modules and frames outside the project", () => {
    expect(
        firstProjectFrame(["    at x (/abs/node_modules/a.js:1:1)", "    at y (./node_modules/a/b.js:3:1)", "    at z (.\\src\\y.ts:7:2)"]),
    ).toBe("src/y.ts:7");
    expect(firstProjectFrame(["    at x (/abs/a.js:1:1)"])).toBeNull();
});

test("the stack screen shows the error entry with its line breaks, and Back returns", async () => {
    const fake = await open(withError);
    await fake.emit(fake.click("stack", OWNER));
    const out = json(fake.lastPayload());
    expect(out).toContain("```log");
    expect(out).toContain("at a (./src/svc/case.service.ts:244:9)\\n    at b (./src/x.ts:2:1)");
    expect(out).not.toContain("after");
    await fake.emit(fake.click("back", OWNER));
    expect(json(fake.lastPayload())).toContain("**Error ID**");
});

test("a very long stack is cut and a stray fence is escaped", async () => {
    const fake = await open([l("error", "boom"), `    at ${"x".repeat(4000)}`, "```"]);
    await fake.emit(fake.click("stack", OWNER));
    const out = json(fake.lastPayload());
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(4200);
    const fenced = await open([l("error", "```")]);
    await fenced.emit(fenced.click("stack", OWNER));
    expect(json(fenced.lastPayload())).not.toContain("```\\n```");
});

test("all lines are paged without splitting a line", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => l("info", `${i}`.repeat(700)));
    expect(pageLines(lines).length).toBe(3);
    for (const page of pageLines(lines)) expect(page.length).toBeLessThanOrEqual(1800);
    const fake = await open(lines);
    await fake.emit(fake.click("lines", OWNER));
    expect(json(fake.lastPayload())).toContain("0".repeat(700));
    expect(json(fake.lastPayload())).not.toContain("5".repeat(700));
    await fake.emit(fake.click("last", OWNER));
    expect(json(fake.lastPayload())).toContain("5".repeat(700));
    await fake.emit(fake.click("back", OWNER));
    expect(json(fake.lastPayload())).toContain("**Error ID**");
});

test("Download replies with the full log as an ephemeral file", async () => {
    const fake = await open(withError);
    const replies: { files: { name: string; attachment: Buffer }[]; flags: number }[] = [];
    const click = {
        ...fake.click("download", OWNER),
        raw: { user: { id: OWNER }, reply: async (b: (typeof replies)[number]) => void replies.push(b) },
    };
    await fake.emit(click as never);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.files[0]?.name).toBe("trace-abc.txt");
    expect(replies[0]?.files[0]?.attachment.toString()).toBe(withError.join("\n"));
    expect(replies[0]?.flags).toBe(64);
});
