import { MessageFlags } from "discord.js";
import { getEnabledBiomes } from "@/usermodules/biomehunt/constants/biomes.constants";
import type { ActivitySessionRow } from "@/usermodules/biomehunt/types";
import { buildSessionEndContainer } from "@/usermodules/biomehunt/views/session-end.view";
import type { TestCase, TestPayload } from "../../registry";

// >24h on purpose - the previous design showed start/end as Discord `:t` (time-of-day only) tags,
// which silently broke for long sessions since the date wasn't shown. This durations formats fine.
const FAKE_DURATION_SECONDS = 1 * 86400 + 5 * 3600 + 42 * 60; // 1d 5h 42m

const FAKE_SESSION: ActivitySessionRow = {
    id: 0,
    user_id: 0,
    started_at: new Date(Date.now() - FAKE_DURATION_SECONDS * 1000),
    ended_at: new Date(),
    duration_seconds: FAKE_DURATION_SECONDS,
};

/** Every biome registered right now, so this preview always covers whatever's currently
 * registered (new biomes included) instead of a hand-picked handful. Rare biomes get a small
 * count, everything else a varied spread - just for a realistic-looking layout. Built per run, so
 * biomes added with `/owner biome add` show up without a restart. */
function fakeBiomes() {
    return getEnabledBiomes().map((meta, i) => ({
        biome: meta.key,
        count: meta.category === "rare" ? (i % 3) + 1 : ((i * 7) % 40) + 1,
    }));
}

export default {
    description: 'The "Session Ended" macro-channel report, with fake session/biome data.',
    run(): TestPayload {
        const container = buildSessionEndContainer(FAKE_SESSION, fakeBiomes(), {
            todaySeconds: 3 * 3600 + 10 * 60,
            windowSeconds: 6 * 3600 + 25 * 60,
            windowHours: 24,
        });
        return { flags: MessageFlags.IsComponentsV2, components: [container] };
    },
} satisfies TestCase;
