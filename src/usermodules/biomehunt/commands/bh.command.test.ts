import { expect, test } from "bun:test";
import command from "./bh.command";

test("/bh registers session with a required integer id", () => {
    const json = (command.options as { toJSON(): { options: Array<{ name: string; description: string; options?: unknown[] }> } }).toJSON();
    const session = json.options.find((o) => o.name === "session");
    expect(session?.description).toBe("Inspect one macro session.");
    expect(session?.options).toEqual([expect.objectContaining({ name: "id", type: 4, required: true, min_value: 1 })]);
});
