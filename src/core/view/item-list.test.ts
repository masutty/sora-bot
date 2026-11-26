import { expect, test } from "bun:test";
import { ButtonBuilder, ButtonStyle, ContainerBuilder } from "discord.js";
import { addItems } from "./item-list";

const button = (id: string) => new ButtonBuilder().setCustomId(id).setLabel("Change").setStyle(ButtonStyle.Secondary);

test("each item is a Section with its button, the note sits below it and dividers go only between items", () => {
    const container = addItems(new ContainerBuilder(), [
        { text: "**A:** 1", button: button("a"), note: "-# about a" },
        { text: "**B:** 2", button: button("b") },
        { text: "**C:** 3", button: button("c") },
    ]);
    const kinds = container.toJSON().components.map((c) => c.type);
    // Section, TextDisplay (note), Separator, Section, Separator, Section
    expect(kinds).toEqual([9, 10, 14, 9, 14, 9]);
    const first = container.toJSON().components[0] as unknown as { components: { content: string }[]; accessory: { custom_id: string } };
    expect(first.components[0]?.content).toBe("**A:** 1");
    expect(first.accessory.custom_id).toBe("a");
});

test("dividers: false leaves no divider between items", () => {
    const container = addItems(
        new ContainerBuilder(),
        [
            { text: "**A:** 1", button: button("a"), note: "-# about a" },
            { text: "**B:** 2", button: button("b") },
        ],
        { dividers: false },
    );
    expect(container.toJSON().components.map((c) => c.type)).toEqual([9, 10, 9]);
});

test("notesBeside puts the note in the Section, under its text", () => {
    const container = addItems(new ContainerBuilder(), [{ text: "**A:** 1", button: button("a"), note: "-# about a" }], {
        notesBeside: true,
    });
    const json = container.toJSON().components;
    expect(json.map((c) => c.type)).toEqual([9]);
    const section = json[0] as unknown as { components: { content: string }[] };
    expect(section.components[0]?.content).toBe("**A:** 1\n-# about a");
});

test("an empty list adds nothing", () => {
    expect(addItems(new ContainerBuilder(), []).toJSON().components).toEqual([]);
});
