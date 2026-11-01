import { UserFacingError } from "@/define";
import * as repo from "../repository/panels.repository";
import { settings } from "../settings";
import type { Block, PanelRow } from "../types";
import {
    blockProblem,
    parseDescription,
    parseEmoji,
    parseImageUrl,
    parseLabel,
    parsePanelName,
    parsePlaceholder,
    parseText,
    parseTitle,
} from "./input";

const FORMAT = "sora-panel";
const VERSION = 1;

/** Far above any real panel (a full one is ~100 KB of text) - only stops a wrong file from being downloaded. */
export const MAX_IMPORT_BYTES = 256 * 1024;

export interface ExportedOption {
    label: string;
    emoji: string | null;
    description: string | null;
    blocks: Block[];
}

/** A panel as it travels between servers: its pages only - never ids, channel or message. */
export interface PanelExportFile {
    format: typeof FORMAT;
    version: typeof VERSION;
    exportedAt: string;
    panel: { name: string; placeholder: string; blocks: Block[]; options: ExportedOption[] };
}

/** Whether the bot can use the custom emoji with this id. */
export type EmojiCheck = (emojiId: string) => boolean | Promise<boolean>;

export type TransferStore = Pick<typeof repo, "listPanels" | "listOptions" | "importPanel">;

/** The panel `ref` names: its id, or its name (case-insensitive). */
export async function findPanel(guildId: string, ref: string, store: Pick<TransferStore, "listPanels"> = repo): Promise<PanelRow> {
    const panels = await store.listPanels(guildId);
    const wanted = ref.trim().toLowerCase();
    const found = panels.find((m) => String(m.id) === wanted) ?? panels.find((m) => m.name.toLowerCase() === wanted);
    if (!found) throw new UserFacingError("I couldn't find that panel.");
    return found;
}

export async function exportPanel(
    guildId: string,
    ref: string,
    store: TransferStore = repo,
): Promise<{ file: PanelExportFile; fileName: string }> {
    const panel = await findPanel(guildId, ref, store);
    const options = await store.listOptions(panel.id);
    const file: PanelExportFile = {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        panel: {
            name: panel.name,
            placeholder: panel.placeholder,
            blocks: panel.blocks,
            options: options.map((o) => ({ label: o.label, emoji: o.emoji, description: o.description, blocks: o.blocks })),
        },
    };
    const slug =
        panel.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "panel";
    return { file, fileName: `panel-${slug}.json` };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Reads and checks a page's blocks with the editor's own rules; `where` names the page in the error. */
function parseBlocks(raw: unknown, where: string): Block[] {
    if (!Array.isArray(raw)) throw new UserFacingError(`${where}: "blocks" must be a list.`);
    const blocks: Block[] = [];
    for (const item of raw) {
        if (!isObject(item)) throw new UserFacingError(`${where}: a block is not an object.`);
        let block: Block;
        try {
            if (item.t === "title") block = { t: "title", v: parseTitle(str(item.v)) };
            else if (item.t === "text") block = { t: "text", v: parseText(str(item.v)) };
            else if (item.t === "sep") block = { t: "sep" };
            else if (item.t === "img") block = { t: "img", url: parseImageUrl(str(item.url)) };
            else throw new UserFacingError("a block has an unknown type.");
            const problem = blockProblem(blocks, block);
            if (problem) throw new UserFacingError(problem);
        } catch (err) {
            if (err instanceof UserFacingError) throw new UserFacingError(`${where}: ${err.message}`);
            throw err;
        }
        blocks.push(block);
    }
    return blocks;
}

export interface ParsedPanel {
    name: string;
    placeholder: string;
    blocks: Block[];
    options: ExportedOption[];
    /** Emoji left out because this bot can't use them (a custom emoji from a server it isn't in, or not an emoji at all). */
    droppedEmoji: number;
}

/** Validates an export file's text. Anything wrong is a `UserFacingError` saying where. */
export async function parsePanelExport(text: string, hasCustomEmoji: EmojiCheck): Promise<ParsedPanel> {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new UserFacingError("That file is not valid JSON.");
    }
    if (!isObject(json) || json.format !== FORMAT || !isObject(json.panel)) throw new UserFacingError("That is not a panel export file.");
    if (json.version !== VERSION) throw new UserFacingError(`I can't read version ${String(json.version)} of this format.`);
    const panel = json.panel;
    const rawOptions = panel.options;
    if (!Array.isArray(rawOptions)) throw new UserFacingError('The file has no "options" list.');
    if (rawOptions.length > settings.maxOptions) throw new UserFacingError(`A panel holds up to ${settings.maxOptions} options.`);

    let droppedEmoji = 0;
    const emojiOf = async (raw: unknown): Promise<string | null> => {
        if (raw === null || raw === undefined || raw === "") return null;
        try {
            const emoji = parseEmoji(str(raw));
            const customId = emoji?.match(/^<a?:\w+:(\d+)>$/)?.[1];
            if (customId && !(await hasCustomEmoji(customId))) throw new UserFacingError("unknown custom emoji");
            return emoji;
        } catch (err) {
            if (!(err instanceof UserFacingError)) throw err;
            droppedEmoji++;
            return null;
        }
    };

    const name = parsePanelName(str(panel.name));
    const parsed: ParsedPanel = {
        name,
        placeholder: parsePlaceholder(str(panel.placeholder)),
        blocks: parseBlocks(panel.blocks, "The root page"),
        options: [],
        droppedEmoji: 0,
    };
    for (const raw of rawOptions) {
        if (!isObject(raw)) throw new UserFacingError("An option is not an object.");
        const label = parseLabel(str(raw.label));
        parsed.options.push({
            label,
            emoji: await emojiOf(raw.emoji),
            description: parseDescription(str(raw.description)),
            blocks: parseBlocks(raw.blocks, `The page "${label}"`),
        });
    }
    parsed.droppedEmoji = droppedEmoji;
    return parsed;
}

/** `name`, or `name (2)`, `name (3)`... when the server already has a panel called that. */
export function uniqueName(name: string, taken: string[]): string {
    const lower = new Set(taken.map((n) => n.toLowerCase()));
    if (!lower.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = `${name.slice(0, settings.maxPanelName - suffix.length)}${suffix}`;
        if (!lower.has(candidate.toLowerCase())) return candidate;
    }
}

/** Creates a NEW panel from an export file's text; never touches an existing one. Not posted anywhere yet. */
export async function importPanelFile(
    guildId: string,
    text: string,
    hasCustomEmoji: EmojiCheck,
    store: TransferStore = repo,
): Promise<{ panel: PanelRow; options: number; droppedEmoji: number }> {
    const parsed = await parsePanelExport(text, hasCustomEmoji);
    const existing = await store.listPanels(guildId);
    if (existing.length >= settings.maxPanelsPerGuild)
        throw new UserFacingError(`A server holds up to ${settings.maxPanelsPerGuild} panels.`);
    const panel = await store.importPanel(guildId, {
        name: uniqueName(
            parsed.name,
            existing.map((m) => m.name),
        ),
        placeholder: parsed.placeholder,
        blocks: parsed.blocks,
        options: parsed.options,
    });
    return { panel, options: parsed.options.length, droppedEmoji: parsed.droppedEmoji };
}
