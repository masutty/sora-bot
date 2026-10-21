import { afterEach, beforeEach, expect, test } from "bun:test";
import { getAllBiomes, resetBiomeRegistry, setBiomeRegistry } from "../constants/biomes.constants";
import { effectiveLastActivity, NO_GRACE, nextActivityGrace } from "./activity.service";

const MIN = 60_000;
const t0 = new Date("2026-10-17T12:00:00Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);

beforeEach(() => {
    // Starfall 10min, Windy 1min, an admin event 2h - every other biome stays untimed.
    const durations: Record<string, number> = { STARFALL: 600, WINDY: 60 };
    setBiomeRegistry([
        ...getAllBiomes().map((e) => (durations[e.key] ? { ...e, durationS: durations[e.key] } : e)),
        { key: "ADMINEVENT", label: "Admin Event", category: "admin", color: 0, durationS: 7200, enabled: true },
    ]);
});
afterEach(() => resetBiomeRegistry());

test("a timed biome's start grants activity until its expected end", () => {
    expect(nextActivityGrace(NO_GRACE, { biome: "ADMINEVENT", eventType: "started" }, t0)).toEqual({ until: at(120), biome: "ADMINEVENT" });
});

test("only the most recent start counts: Starfall then Windy (Biome Randomizer) leaves Windy's 1 minute", () => {
    const afterStarfall = nextActivityGrace(NO_GRACE, { biome: "STARFALL", eventType: "started" }, t0);
    const afterWindy = nextActivityGrace(afterStarfall, { biome: "WINDY", eventType: "started" }, at(1));
    expect(afterWindy).toEqual({ until: at(2), biome: "WINDY" });
});

test("starting an untimed biome drops a running grace", () => {
    const admin = nextActivityGrace(NO_GRACE, { biome: "ADMINEVENT", eventType: "started" }, t0);
    expect(nextActivityGrace(admin, { biome: "HELL", eventType: "started" }, at(5))).toEqual(NO_GRACE);
});

test("the grace biome's own Ended ends it early; another biome's Ended or an unparsed event keeps it", () => {
    const admin = nextActivityGrace(NO_GRACE, { biome: "ADMINEVENT", eventType: "started" }, t0);
    expect(nextActivityGrace(admin, { biome: "ADMINEVENT", eventType: "ended" }, at(30))).toEqual(NO_GRACE);
    expect(nextActivityGrace(admin, { biome: "HELL", eventType: "ended" }, at(30))).toEqual(admin);
    expect(nextActivityGrace(admin, { biome: null, eventType: null }, at(30))).toEqual(admin);
});

test("activity is measured from the later of the last message and the grace end", () => {
    expect(effectiveLastActivity(t0, at(120))).toEqual(at(120));
    expect(effectiveLastActivity(at(130), at(120))).toEqual(at(130));
    expect(effectiveLastActivity(t0, null)).toEqual(t0);
    expect(effectiveLastActivity(null, null)).toBeNull();
});
