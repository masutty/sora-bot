import { ContainerBuilder, MessageFlags, SeparatorSpacingSize, TextDisplayBuilder } from "discord.js";
import { defineView, type ViewPayload } from "@/define";
import { NO_PINGS, unix } from "@/utils/format";
import type { TestCase } from "../../registry";

/**
 * Candidate layouts for how `/bh-stats quotas` lists members and separates who hit the target from
 * who didn't. Fake data only; names are bold text standing in for the real `<@id>` mention pill.
 */
const TARGET = 5 * 3600;
const MEMBERS: Array<{ name: string; seconds: number }> = [
    { name: "yumi", seconds: 7 * 3600 + 12 * 60 },
    { name: "quin [PING 4 ANY]", seconds: 6 * 3600 + 3 * 60 },
    { name: "Furry", seconds: 5 * 3600 + 2 * 60 },
    { name: "Gloomy Tree | Fish Builder", seconds: 2 * 3600 },
    { name: "bnuy", seconds: 3600 + 55 * 60 },
    { name: "goodname", seconds: 3600 + 53 * 60 },
    { name: "m20tt", seconds: 3600 + 18 * 60 },
    { name: "masutty", seconds: 0 },
];

function formatHm(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

const name = (m: { name: string }) => `**@${m.name}**`;
const time = (m: { seconds: number }) => `\`${formatHm(m.seconds)}\``;
const hits = MEMBERS.filter((m) => m.seconds >= TARGET);
const misses = MEMBERS.filter((m) => m.seconds < TARGET);

/** Ten little blocks of progress toward the target, capped at full. */
function bar(seconds: number): string {
    const filled = Math.min(10, Math.round((seconds / TARGET) * 10));
    return `\`${"▰".repeat(filled)}${"▱".repeat(10 - filled)}\``;
}

interface Layout {
    label: string;
    description: string;
    /** Text blocks under the role heading; a `null` entry becomes a real divider between blocks. */
    body(): Array<string | null>;
}

const LAYOUTS: Record<string, Layout> = {
    current: {
        label: "Current",
        description: "Inline list with a text target line (what's live now)",
        body: () => [
            `> ${hits.map((m) => `${name(m)} ${time(m)}`).join(" · ")}\n-# ── target \`5h\` ──\n> ${misses.map((m) => `${name(m)} ${time(m)}`).join(" · ")}`,
        ],
    },
    vertical: {
        label: "One per line",
        description: "Each member on its own line, a real divider at the target",
        body: () => [hits.map((m) => `${name(m)} · ${time(m)}`).join("\n"), null, misses.map((m) => `${name(m)} · ${time(m)}`).join("\n")],
    },
    ranked: {
        label: "Ranked",
        description: "One per line with the position, time first",
        body: () => [
            hits.map((m, i) => `\`#${i + 1}\` ${time(m)} ${name(m)}`).join("\n"),
            null,
            misses.map((m, i) => `\`#${hits.length + i + 1}\` ${time(m)} ${name(m)}`).join("\n"),
        ],
    },
    icons: {
        label: "Status icons",
        description: "✅ / ⏳ on each line, no separator needed",
        body: () => [MEMBERS.map((m) => `${m.seconds >= TARGET ? "✅" : "⏳"} ${time(m)} ${name(m)}`).join("\n")],
    },
    groups: {
        label: "Labelled groups",
        description: "'- `✅ Hit`' / '- `⏳ Not yet`' headers, one member per line",
        body: () => [
            `- \`✅ Hit · ${hits.length}\`\n${hits.map((m) => `> ${time(m)} ${name(m)}`).join("\n")}`,
            `- \`⏳ Not yet · ${misses.length}\`\n${misses.map((m) => `> ${time(m)} ${name(m)}`).join("\n")}`,
        ],
    },
    progress: {
        label: "Progress bars",
        description: "A bar toward the target on every line",
        body: () => [MEMBERS.map((m) => `${bar(m.seconds)} ${time(m)} ${name(m)}`).join("\n")],
    },
};

function buildCard(layout: Layout): ContainerBuilder {
    const now = new Date();
    const c = new ContainerBuilder().setAccentColor(0x5865f2);
    c.addTextDisplayComponents((td) =>
        td.setContent(
            `## Quotas · Today\n> -# from <t:${unix(new Date(now.getTime() - 2 * 3_600_000))}:f> to <t:${unix(new Date(now.getTime() + 22 * 3_600_000 - 60_000))}:f>`,
        ),
    );
    c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    c.addTextDisplayComponents((td) => td.setContent("### **@Macro: met quota**\n-# Target: `5h` per day"));
    for (const block of layout.body()) {
        if (block === null) c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        else c.addTextDisplayComponents((td) => td.setContent(block));
    }
    return c;
}

export default {
    description: "Candidate layouts for the /bh-stats quotas member list and its hit / not yet separation - fake data.",
    view() {
        return defineView<{ layout: string }, void, void>({
            name: "tests.quota-layouts",
            initial: () => ({ layout: "vertical" }),
            render: (state, kit): ViewPayload => ({
                flags: MessageFlags.IsComponentsV2,
                components: [
                    new TextDisplayBuilder().setContent(`-# Layout: **${LAYOUTS[state.layout].label}**`),
                    buildCard(LAYOUTS[state.layout]),
                    kit.row(
                        kit.stringSelect("layout", (s) =>
                            s.setPlaceholder("Layout").addOptions(
                                Object.entries(LAYOUTS).map(([value, l]) => ({
                                    label: l.label,
                                    value,
                                    description: l.description,
                                    default: value === state.layout,
                                })),
                            ),
                        ),
                    ),
                ],
                allowedMentions: NO_PINGS,
            }),
            on: {
                layout: (c) => {
                    c.state.layout = c.values[0];
                },
            },
        });
    },
} satisfies TestCase;
