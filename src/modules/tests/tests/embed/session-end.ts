import { MessageFlags } from "discord.js";
import { buildSessionEndContainer } from "@/modules/biomehunt/services/SessionReportEngine";
import { BIOME_META } from "@/modules/biomehunt/types";
import type { ActivitySessionRow } from "@/modules/biomehunt/types";
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

/** Every biome BIOME_META knows about right now, so this preview always covers whatever's
 * currently registered (new biomes included) instead of a hand-picked handful. Rare biomes get a
 * small count, everything else a varied spread - just for a realistic-looking layout. */
const FAKE_BIOMES = Object.keys(BIOME_META).map((biome, i) => ({
    biome,
    count: BIOME_META[biome].category === "rare" ? (i % 3) + 1 : ((i * 7) % 40) + 1,
}));

export default {
    description: "BiomeHunt's \"Session Ended\" macro-channel report, with fake session/biome data.",
    run(): TestPayload {
        const container = buildSessionEndContainer(FAKE_SESSION, FAKE_BIOMES);
        return { flags: MessageFlags.IsComponentsV2, components: [container] };
    },
} satisfies TestCase;
