import { ContainerBuilder, MessageFlags } from "discord.js";
import { formatCodeblock } from "@/utils/format";
import type { TestCase, TestPayload } from "../../registry";

/**
 * The full set of codes Discord's `ansi` codeblock actually renders (community-verified, not
 * documented by Discord itself): bold(1)/underline(4) as modifiers, and only these 8 foreground
 * colors (30-37) and 8 background colors (40-47) - anything outside this set (256-color, truecolor
 * escapes) is just printed as literal text instead of applying a color.
 */
const FOREGROUND: Array<{ code: number; name: string }> = [
    { code: 30, name: "Gray" },
    { code: 31, name: "Red" },
    { code: 32, name: "Green" },
    { code: 33, name: "Yellow" },
    { code: 34, name: "Blue" },
    { code: 35, name: "Pink" },
    { code: 36, name: "Cyan" },
    { code: 37, name: "White" },
];

const BACKGROUND: Array<{ code: number; name: string }> = [
    { code: 40, name: "Firefly dark blue" },
    { code: 41, name: "Orange" },
    { code: 42, name: "Marble blue" },
    { code: 43, name: "Greyish turquoise" },
    { code: 44, name: "Gray" },
    { code: 45, name: "Indigo" },
    { code: 46, name: "Light gray" },
    { code: 47, name: "White" },
];

const RESET = "\u001b[0m";

function swatchLines(weight: "" | "1;"): string {
    return FOREGROUND.map(({ code, name }) => `\u001b[${weight}${code}m${name} (${weight}${code})${RESET}`).join("\n");
}

function backgroundLines(): string {
    return BACKGROUND.map(({ code, name }) => `\u001b[30;${code}m${name} (${code}) on bg${RESET}`).join("\n");
}

/** Yes, fg + bg (+ bold) combine in one code: `\u001b[1;<fg>;<bg>m`. One row per background, one
 * swatch block per foreground - the full 8x8 grid (64 combos) in 8 compact lines. */
function combinedGrid(): string {
    return BACKGROUND.map(({ code: bg }) => FOREGROUND.map(({ code: fg }) => `\u001b[1;${fg};${bg}m██${RESET}`).join("")).join("\n");
}

/** A few combos with real text instead of blocks, so you can judge actual legibility, not just color. */
const LABELED_COMBOS: Array<{ label: string; fg: number; bg: number }> = [
    { label: "Bold White on Orange", fg: 37, bg: 41 },
    { label: "Bold White on Firefly Dark Blue", fg: 37, bg: 40 },
    { label: "Bold White on Indigo", fg: 37, bg: 45 },
    { label: "Bold Gray on Light Gray", fg: 30, bg: 46 },
    { label: "Bold Red on White", fg: 31, bg: 47 },
    { label: "Bold Yellow on Marble Blue", fg: 33, bg: 42 },
];

function labeledComboLines(): string {
    return LABELED_COMBOS.map(({ label, fg, bg }) => `\u001b[1;${fg};${bg}m ${label} \u001b[0m`).join("\n");
}

export default {
    description: "Reference swatch of every ANSI color/style Discord's `ansi` codeblock actually renders.",
    run(): TestPayload {
        const container = new ContainerBuilder().setAccentColor(0x5865f2);

        container.addTextDisplayComponents((td) => td.setContent("## 🎨 ANSI Color Reference"));
        container.addTextDisplayComponents((td) => td.setContent(`**Normal**\n${formatCodeblock(swatchLines(""), "ansi")}`));
        container.addTextDisplayComponents((td) => td.setContent(`**Bold**\n${formatCodeblock(swatchLines("1;"), "ansi")}`));
        container.addTextDisplayComponents((td) => td.setContent(`**Background** (fg 30, various bg)\n${formatCodeblock(backgroundLines(), "ansi")}`));
        container.addTextDisplayComponents((td) =>
            td.setContent(`**Combined (fg + bg, bold)** - rows are backgrounds 40-47, columns are foregrounds 30-37\n${formatCodeblock(combinedGrid(), "ansi")}`),
        );
        container.addTextDisplayComponents((td) => td.setContent(`**Combined, with text**\n${formatCodeblock(labeledComboLines(), "ansi")}`));

        return { flags: MessageFlags.IsComponentsV2, components: [container] };
    },
} satisfies TestCase;
