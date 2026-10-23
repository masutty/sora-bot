import { expect, test } from "bun:test";
import command from "./bh.command";

test("/bh registers session with a required integer id", () => {
    const json = (command.options as { toJSON(): { options: Array<{ name: string; description: string; options?: unknown[] }> } }).toJSON();
    const session = json.options.find((o) => o.name === "session");
    expect(session?.description).toBe("Inspect one macro session.");
    expect(session?.options).toEqual([expect.objectContaining({ name: "id", type: 4, required: true, min_value: 1 })]);
});

test("/bh registers rare-finds with an optional user", () => {
    const json = (command.options as { toJSON(): { options: Array<{ name: string; description: string; options?: unknown[] }> } }).toJSON();
    const sub = json.options.find((o) => o.name === "rare-finds");
    expect(sub?.description).toBe("View a member's rare biome finds.");
    expect(sub?.options).toEqual([
        expect.objectContaining({ name: "user", type: 6, description: "Whose rare finds to view (defaults to yourself)" }),
    ]);
});
