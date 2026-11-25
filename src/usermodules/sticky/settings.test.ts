import { expect, test } from "bun:test";
import { delayLabel, modeLabel } from "./settings";

test("delayLabel", () => {
    expect(delayLabel(300)).toBe("5 min");
    expect(delayLabel(3600)).toBe("1 hour");
    expect(delayLabel(10800)).toBe("3 hours");
    expect(delayLabel(86400)).toBe("24 hours");
});

test("modeLabel", () => {
    expect(modeLabel("all")).toBe("All messages");
    expect(modeLabel("nobots")).toBe("No bots");
});
