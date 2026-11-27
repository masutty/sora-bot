import {
    AttachmentBuilder,
    ButtonStyle,
    ContainerBuilder,
    type MessageComponentInteraction,
    MessageFlags,
    SeparatorSpacingSize,
} from "discord.js";
import { defineView, paginationHandlers, paginationRow, type ViewDefinition } from "@/define";
import { cut, formatCodeblock, NO_PINGS, unix } from "@/utils/format";
import { LOG_LINE, readTraceFacts } from "@/utils/trace-lookup";

/** Longest error entry shown on the Stack trace screen. */
export const STACK_MAX = 3500;
/** Longest text of one page on the All lines screen; a line is never split across pages. */
export const PAGE_MAX = 1800;

// `at fn (./src/x.ts:244:5)`: a frame inside the project, after the paths were sanitized to `./` or `.\`.
const PROJECT_FRAME = /(?:^|[\s(])\.[\\/]([^\s():]+:\d+)/;

/** The first error entry: its line and the stack lines under it (lines that don't start a new entry). */
function errorEntry(lines: string[], errorIndex: number): string[] {
    const entry = [lines[errorIndex] as string];
    for (let i = errorIndex + 1; i < lines.length && !LOG_LINE.test(lines[i] as string); i++) entry.push(lines[i] as string);
    return entry;
}

/** The first stack frame inside the project (`src/x.ts:244`), without `node_modules` frames. */
export function firstProjectFrame(entry: string[]): string | null {
    for (const line of entry) {
        const found = PROJECT_FRAME.exec(line)?.[1];
        if (found && !found.includes("node_modules")) return found.replaceAll("\\", "/");
    }
    return null;
}

/** Lines grouped into pages of about `max` characters; a line stays whole (one longer than a page is shortened). */
export function pageLines(lines: string[], max = PAGE_MAX): string[] {
    const pages: string[] = [];
    let current = "";
    for (const raw of lines) {
        const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
        const next = current ? `${current}\n${line}` : line;
        if (current && next.length > max) {
            pages.push(current);
            current = line;
        } else current = next;
    }
    if (current) pages.push(current);
    return pages.length ? pages : [""];
}

const fence = (text: string) => formatCodeblock(text.replaceAll("```", "`​``"), "log");

export interface TraceState {
    id: string;
    lines: string[];
    screen: "summary" | "stack" | "lines";
    page: number;
}

const TYPE_LABEL = { ok: "No error", "user-error": "User error", error: "Internal error" } as const;

/** The summary as groups of text, each shown under its own divider; a group without data is left out. */
function summaryGroups(state: TraceState, errorIndex: number): string[] {
    const { id, lines } = state;
    const facts = readTraceFacts(lines);
    const errorMatch = errorIndex >= 0 ? LOG_LINE.exec(lines[errorIndex] as string) : null;
    const type = facts.outcome ?? (errorMatch ? "error" : "ok");
    // The command can finish fine while something inside it logs an error (e.g. a skipped Auto-Punishment).
    const label = type === "ok" && errorMatch ? "Finished, but something inside it failed" : TYPE_LABEL[type];

    const groups = [`**Error ID** \`${id}\`\n-# ${label}`];

    const at = facts.time ? unix(new Date(facts.time.replace(" ", "T"))) : null;
    const invocation = [
        facts.userId ? `- **Invoker:** <@${facts.userId}>${facts.userTag ? ` (\`${facts.userTag}\`)` : ""}` : null,
        facts.guildId ? `- **Server:** \`${facts.guildId}\`` : null,
        at ? `- **When:** <t:${at}:f> (<t:${at}:R>)` : null,
        facts.tookMs !== null ? `- **Took:** ${facts.tookMs}ms` : null,
    ].filter(Boolean);
    if (invocation.length) groups.push(["**Invocation**", ...invocation].join("\n"));

    // The command and what it was given sit together: that is what the user typed.
    const command = [
        facts.command ? `- **Name:** \`${facts.command}\` (${facts.command.startsWith("/") ? "slash" : "prefix"})` : null,
        facts.args !== null ? `- **Arguments:** ${facts.args ? `\`${cut(facts.args, 500)}\`` : "None"}` : null,
    ].filter(Boolean);
    if (command.length) groups.push(["**Command**", ...command].join("\n"));

    const message = errorMatch ? (errorMatch[4] as string) : facts.userError;
    const where = errorIndex >= 0 ? firstProjectFrame(errorEntry(lines, errorIndex)) : null;
    if (message) {
        const quoted = cut(message, 1000)
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n");
        groups.push(`**Error**\n${quoted}${where ? `\n- **Where:** \`${where}\`` : ""}`);
    }
    groups.push(`-# ${lines.length} log ${lines.length === 1 ? "line" : "lines"}`);
    return groups;
}

/** `/bot trace <id>`: a summary of one invocation's log, with its stack trace, every line and a file to download. */
export function traceView(): ViewDefinition<TraceState, void, { id: string; lines: string[] }> {
    const errorAt = (lines: string[]) => lines.findIndex((l) => LOG_LINE.exec(l)?.[2] === "error");
    const pagesOf = (s: TraceState) => pageLines(s.lines).length;

    return defineView<TraceState, void, { id: string; lines: string[] }>({
        name: "bot_internals.trace",
        initial: ({ id, lines }) => ({ id, lines, screen: "summary", page: 0 }),
        access: "invoker",
        render: (state, kit) => {
            const errorIndex = errorAt(state.lines);
            const container = new ContainerBuilder().setAccentColor(errorIndex >= 0 ? 0xda373c : 0x5865f2);
            const text = (content: string) => container.addTextDisplayComponents((td) => td.setContent(content));
            const back = kit.button("back", (b) => b.setLabel("Back"));

            if (state.screen === "stack") {
                // Not `cut`: it flattens line breaks, and a stack trace needs them.
                const entry = errorEntry(state.lines, errorIndex).join("\n");
                text(fence(entry.length > STACK_MAX ? `${entry.slice(0, STACK_MAX - 1)}…` : entry));
                return { flags: MessageFlags.IsComponentsV2, components: [container, kit.row(back)], allowedMentions: NO_PINGS };
            }
            if (state.screen === "lines") {
                text(fence(pageLines(state.lines)[state.page] ?? ""));
                return {
                    flags: MessageFlags.IsComponentsV2,
                    components: [container, paginationRow(kit, state.page, pagesOf(state)), kit.row(back)],
                    allowedMentions: NO_PINGS,
                };
            }
            summaryGroups(state, errorIndex).forEach((group, i) => {
                if (i > 0) container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                text(group);
            });
            const buttons = [
                errorIndex >= 0 ? kit.button("stack", (b) => b.setLabel("Stack trace")) : null,
                kit.button("lines", (b) => b.setLabel("All lines")),
                kit.button("download", (b) => b.setLabel("Download").setStyle(ButtonStyle.Primary)),
            ].filter((b) => b !== null);
            return { flags: MessageFlags.IsComponentsV2, components: [container, kit.row(...buttons)], allowedMentions: NO_PINGS };
        },
        on: {
            ...paginationHandlers<TraceState>({ pages: pagesOf }),
            stack: (c) => {
                c.state.screen = "stack";
            },
            lines: (c) => {
                c.state.screen = "lines";
                c.state.page = 0;
            },
            back: (c) => {
                c.state.screen = "summary";
            },
            // `c.notify` is text only, so the file goes through the raw interaction. The engine's
            // redraw then edits the message, since the click is already answered.
            download: async (c) => {
                const file = new AttachmentBuilder(Buffer.from(c.state.lines.join("\n")), { name: `trace-${c.state.id}.txt` });
                await (c.raw as MessageComponentInteraction).reply({
                    files: [file],
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: NO_PINGS,
                });
            },
        },
    });
}
