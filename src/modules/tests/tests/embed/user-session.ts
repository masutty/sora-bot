import { ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import { formatTime, unix } from "@/utils/format";
import type { TestCase, TestPayload } from "../../registry";

interface FakeSession {
    id: number;
    started_at: Date;
    ended_at: Date;
    duration_seconds: number;
}

/** A realistic-looking spread: some short, some long, some crossing into previous days. */
function buildFakeSessions(): FakeSession[] {
    const now = Date.now();
    const specs = [
        { hoursAgo: 1, minutes: 45 },
        { hoursAgo: 6, minutes: 132 },
        { hoursAgo: 27, minutes: 18 },
        { hoursAgo: 31, minutes: 341 },
        { hoursAgo: 53, minutes: 64 },
        { hoursAgo: 80, minutes: 5 },
    ];
    return specs.map((s, i) => {
        const endedAt = new Date(now - s.hoursAgo * 3_600_000);
        const durationSeconds = s.minutes * 60;
        return {
            id: specs.length - i,
            started_at: new Date(endedAt.getTime() - durationSeconds * 1000),
            ended_at: endedAt,
            duration_seconds: durationSeconds,
        };
    });
}

const USERNAME = "not.good.enough";

function addDivider(container: ContainerBuilder): void {
    container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));
}

/**
 * Winning design: "ended-only" digest - one line per completed session (id, duration, when it
 * ended), plus a "Currently macroing" banner when there's an open session. Mirrors
 * `buildSessionsTabContainer` in commands/profileViews.ts - keep the two in sync if this changes.
 */
export default {
    description: "BiomeHunt's real Session History layout (ended-only digest + \"currently macroing\" banner), with fake data.",
    run(): TestPayload {
        const sessions = buildFakeSessions();
        const ongoingStartedAt = new Date(Date.now() - 12 * 60_000);

        const container = new ContainerBuilder().setAccentColor(0x5865f2);
        container.addTextDisplayComponents((td) => td.setContent(`## \`${USERNAME}\`'s Session History`));
        addDivider(container);

        const lines = [
            `🟢 Currently macroing (started <t:${unix(ongoingStartedAt)}:R>)`,
            ...sessions.map((s) => `⏱️ \`#${s.id}\` · \`${formatTime(s.duration_seconds)}\` · ended <t:${unix(s.ended_at)}:R>`),
        ];
        container.addTextDisplayComponents((td) => td.setContent(lines.join("\n")));

        addDivider(container);
        container.addTextDisplayComponents((td) => td.setContent(`-# Page 1 of 1, ${sessions.length} total sessions`));

        return { flags: MessageFlags.IsComponentsV2, components: [container] };
    },
} satisfies TestCase;
