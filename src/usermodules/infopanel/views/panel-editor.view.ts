import { ButtonStyle, type Client } from "discord.js";
import {
    confirm,
    defineView,
    type HandlerContext,
    type HandlerResult,
    paginationHandlers,
    UserFacingError,
    type ViewDefinition,
} from "@/define";
import { EmbedFormatter } from "@/utils/format";
import * as repo from "../repository/panels.repository";
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
} from "../services/input";
import { discordPublisher, type PanelService, panelService } from "../services/panel.service";
import { settings } from "../settings";
import type { Block } from "../types";
import { currentBlocks, currentOption, currentPanel, type EditorState, listPages, renderEditor } from "./panel-editor.screens";

/** What the editor needs that would otherwise be a DB/Discord call, injected so its tests never hit any of them. */
export interface EditorDeps {
    guildId: string;
    listPanels: typeof repo.listPanels;
    insertPanel: typeof repo.insertPanel;
    updatePanel: typeof repo.updatePanel;
    listOptions: typeof repo.listOptions;
    insertOption: typeof repo.insertOption;
    updateOption: typeof repo.updateOption;
    deleteOption: typeof repo.deleteOption;
    moveOption: typeof repo.moveOption;
    /** Whether the bot can use this custom emoji: this server's, or one from another server the bot is in. */
    hasCustomEmoji(emojiId: string): Promise<boolean>;
    /** `<:name:id>` of the custom emoji called `name` in THIS server; null when it has none by that name. */
    findCustomEmoji(name: string): Promise<string | null>;
    service: PanelService;
}

export function defaultEditorDeps(client: Client, guildId: string): EditorDeps {
    // The bot has no emoji intent, so its cache never hears about an emoji made after it started:
    // a miss in this server falls back to asking Discord.
    const guild = () => client.guilds.cache.get(guildId);
    return {
        ...repo,
        guildId,
        hasCustomEmoji: async (id) => {
            if (client.emojis.cache.has(id)) return true;
            return Boolean(
                await guild()
                    ?.emojis.fetch(id)
                    .catch(() => null),
            );
        },
        findCustomEmoji: async (name) => {
            const byName = (e: { name: string | null }) => e.name === name;
            const emojis = guild()?.emojis;
            const emoji = emojis?.cache.find(byName) ?? (await emojis?.fetch().catch(() => null))?.find(byName);
            return emoji ? emoji.toString() : null;
        },
        service: panelService(discordPublisher(client)),
    };
}

type Ctx = HandlerContext<EditorState, void>;

const CUSTOM_EMOJI_ID = /^<a?:\w+:(\d+)>$/;
/** `:tragedy:` - how a custom emoji lands in a text field. */
const EMOJI_SHORTCODE = /^:(\w{2,32}):$/;

const pagesOf = (s: EditorState) => listPages(s.screen === "options" ? s.options.length : s.panels.length);

/** The Add and Edit option form; `option` prefills it. */
const optionFields = (option?: { label: string; emoji: string | null; description: string | null }) => [
    { key: "label", label: "Label", value: option?.label, required: true, maxLength: settings.maxLabel },
    { key: "emoji", label: "Emoji", value: option?.emoji ?? undefined, placeholder: "📜 or :name:", required: false, maxLength: 64 },
    {
        key: "description",
        label: "Description",
        value: option?.description ?? undefined,
        required: false,
        maxLength: settings.maxDescription,
    },
];

export function panelEditorView(deps: EditorDeps): ViewDefinition<EditorState, void, void> {
    const { guildId, service } = deps;

    /**
     * Reads the emoji field: a unicode emoji, `:name:` (this server's emoji only) or a pasted
     * `<:name:id>` (any server the bot is in). A custom emoji the bot can't
     * see is refused, since Discord would reject the whole select.
     */
    async function emojiOf(raw: string | undefined): Promise<string | null> {
        const name = raw?.trim().match(EMOJI_SHORTCODE)?.[1];
        if (name) {
            const found = await deps.findCustomEmoji(name);
            if (!found) {
                throw new UserFacingError(
                    `This server has no emoji called :${name}:. For one from another server, paste it with its id: <:${name}:id>.`,
                );
            }
            return found;
        }
        const emoji = parseEmoji(raw);
        const customId = emoji?.match(CUSTOM_EMOJI_ID)?.[1];
        if (customId && !(await deps.hasCustomEmoji(customId))) {
            throw new UserFacingError("I can only use custom emoji from a server I'm in.");
        }
        return emoji;
    }

    /** Re-reads the panels and the open panel's options; falls back a screen when what was open is gone. */
    async function reload(s: EditorState): Promise<void> {
        s.panels = await deps.listPanels(guildId);
        const panel = currentPanel(s);
        if (!panel) {
            s.panelId = null;
            s.options = [];
            s.optionId = null;
            s.screen = "panels";
        } else {
            s.options = await deps.listOptions(panel.id);
            if (s.optionId !== null && !currentOption(s)) {
                s.optionId = null;
                if (s.screen === "page") s.screen = "options";
            }
        }
        s.page = Math.min(s.page, pagesOf(s) - 1);
        s.blockIndex = Math.max(0, Math.min(s.blockIndex, currentBlocks(s).length - 1));
    }

    /** Runs a handler; an expected error is told to the admin and the screen stays as it was. */
    const guarded =
        (fn: (c: Ctx) => HandlerResult<EditorState>) =>
        // biome-ignore lint/suspicious/noConfusingVoidType: mirrors HandlerResult - a handler that only mutates the state returns nothing.
        async (c: Ctx): Promise<EditorState | void> => {
            try {
                return await fn(c);
            } catch (err) {
                if (!(err instanceof UserFacingError)) throw err;
                await c.notify(err.message);
            }
        };

    /** Saves the open page's blocks; the posted message follows when it is the root. */
    async function saveBlocks(s: EditorState, blocks: Block[]): Promise<void> {
        const panel = currentPanel(s);
        const option = currentOption(s);
        if (!panel) return;
        if (option) {
            await deps.updateOption(option.id, { blocks });
        } else {
            await deps.updatePanel(panel.id, { blocks });
            await service.refresh(panel.id);
        }
        await reload(s);
    }

    async function addBlock(
        c: Ctx,
        title: string,
        label: string,
        style: "short" | "paragraph",
        maxLength: number,
        build: (value: string) => Block,
    ): Promise<void> {
        const values = await c.modal({ title, fields: [{ key: "v", label, style, required: true, maxLength }] });
        if (!values) return;
        const block = build(values.v);
        const blocks = currentBlocks(c.state);
        const problem = blockProblem(blocks, block);
        if (problem) throw new UserFacingError(problem);
        await saveBlocks(c.state, [...blocks, block]);
        c.state.blockIndex = currentBlocks(c.state).length - 1;
    }

    async function editBlock(c: Ctx): Promise<void> {
        const blocks = currentBlocks(c.state);
        const picked = blocks[c.state.blockIndex];
        if (!picked || picked.t === "sep") return;
        const isImage = picked.t === "img";
        const values = await c.modal({
            title: isImage ? "Image" : picked.t === "title" ? "Title" : "Text",
            fields: [
                {
                    key: "v",
                    label: isImage ? "Image URL" : picked.t === "title" ? "Title" : "Text",
                    style: picked.t === "text" ? "paragraph" : "short",
                    value: picked.t === "img" ? picked.url : picked.v,
                    required: true,
                    maxLength: isImage ? settings.maxUrl : picked.t === "title" ? settings.maxTitle : settings.maxTextBlock,
                },
            ],
        });
        if (!values) return;
        const block: Block =
            picked.t === "img"
                ? { t: "img", url: parseImageUrl(values.v) }
                : picked.t === "title"
                  ? { t: "title", v: parseTitle(values.v) }
                  : { t: "text", v: parseText(values.v) };
        const problem = blockProblem(blocks, block, c.state.blockIndex);
        if (problem) throw new UserFacingError(problem);
        await saveBlocks(
            c.state,
            blocks.map((b, i) => (i === c.state.blockIndex ? block : b)),
        );
    }

    async function moveBlock(c: Ctx, step: -1 | 1): Promise<void> {
        const blocks = [...currentBlocks(c.state)];
        const from = c.state.blockIndex;
        const to = from + step;
        if (to < 0 || to >= blocks.length) return;
        [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
        await saveBlocks(c.state, blocks);
        c.state.blockIndex = to;
    }

    async function rename(c: Ctx): Promise<void> {
        const panel = currentPanel(c.state);
        if (!panel) return;
        const option = currentOption(c.state);
        if (option) {
            const values = await c.modal({ title: "Option", fields: optionFields(option) });
            if (!values) return;
            await deps.updateOption(option.id, {
                label: parseLabel(values.label),
                emoji: await emojiOf(values.emoji),
                description: parseDescription(values.description),
            });
        } else {
            const values = await c.modal({
                title: "Panel",
                fields: [
                    { key: "name", label: "Name", value: panel.name, required: true, maxLength: settings.maxPanelName },
                    {
                        key: "placeholder",
                        label: "Select text",
                        value: panel.placeholder,
                        required: false,
                        maxLength: settings.maxPlaceholder,
                    },
                ],
            });
            if (!values) return;
            await deps.updatePanel(panel.id, { name: parsePanelName(values.name), placeholder: parsePlaceholder(values.placeholder) });
        }
        await reload(c.state);
        await service.refresh(panel.id);
    }

    /** Asks before a delete; true once `action` ran. */
    async function confirmed(c: Ctx, title: string, body: string, action: () => Promise<void>): Promise<boolean> {
        const ok = await c.open(
            confirm({
                name: "infopanel.confirm",
                title,
                body,
                color: 0xda373c,
                confirmLabel: "Delete",
                confirmStyle: ButtonStyle.Danger,
                cancelLabel: "Cancel",
                cancelStyle: ButtonStyle.Secondary,
                onConfirm: async () => {
                    await action();
                    return EmbedFormatter.info("Deleted.");
                },
            }),
            undefined,
        );
        return ok === true;
    }

    const listHandlers = Object.fromEntries(
        Array.from({ length: settings.listPerPage }, (_, slot) => [
            `open:${slot}`,
            guarded(async (c: Ctx) => {
                const panel = c.state.panels[c.state.page * settings.listPerPage + slot];
                if (!panel) return;
                Object.assign(c.state, { panelId: panel.id, optionId: null, screen: "page", blockIndex: 0, page: 0 });
                await reload(c.state);
            }),
        ]),
    );
    const optionHandlers = Object.fromEntries(
        Array.from({ length: settings.listPerPage }, (_, slot) => [
            `edit:${slot}`,
            guarded(async (c: Ctx) => {
                const option = c.state.options[c.state.page * settings.listPerPage + slot];
                if (!option) return;
                Object.assign(c.state, { optionId: option.id, screen: "page", blockIndex: 0 });
            }),
        ]),
    );

    return defineView<EditorState, void, void>({
        name: "infopanel.editor",
        initial: async () => {
            const s: EditorState = {
                screen: "panels",
                page: 0,
                panels: [],
                panelId: null,
                options: [],
                optionId: null,
                blockIndex: 0,
                channelId: null,
            };
            await reload(s);
            return s;
        },
        render: renderEditor,
        on: {
            ...paginationHandlers<EditorState>({ pages: pagesOf }),
            ...listHandlers,
            ...optionHandlers,

            close: (c) => c.done(undefined),

            addPanel: guarded(async (c) => {
                const values = await c.modal({
                    title: "New panel",
                    fields: [{ key: "name", label: "Name", required: true, maxLength: settings.maxPanelName }],
                });
                if (!values) return;
                const name = parsePanelName(values.name);
                if ((await deps.listPanels(guildId)).length >= settings.maxPanelsPerGuild) {
                    throw new UserFacingError(`A server holds up to ${settings.maxPanelsPerGuild} panels.`);
                }
                const panel = await deps.insertPanel(guildId, name, settings.defaultPlaceholder, [{ t: "title", v: name }]);
                Object.assign(c.state, { panelId: panel.id, optionId: null, screen: "page", blockIndex: 0, page: 0 });
                await reload(c.state);
            }),

            target: (c) => {
                const value = c.values[0];
                c.state.optionId = value === "root" ? null : Number(value);
                c.state.blockIndex = 0;
            },
            block: (c) => {
                c.state.blockIndex = Number(c.values[0]);
            },

            addTitle: guarded((c) => addBlock(c, "Title", "Title", "short", settings.maxTitle, (v) => ({ t: "title", v: parseTitle(v) }))),
            addText: guarded((c) =>
                addBlock(c, "Text", "Text", "paragraph", settings.maxTextBlock, (v) => ({ t: "text", v: parseText(v) })),
            ),
            addImage: guarded((c) =>
                addBlock(c, "Image", "Image URL", "short", settings.maxUrl, (v) => ({ t: "img", url: parseImageUrl(v) })),
            ),
            addSep: guarded(async (c) => {
                const blocks = currentBlocks(c.state);
                const block: Block = { t: "sep" };
                const problem = blockProblem(blocks, block);
                if (problem) throw new UserFacingError(problem);
                await saveBlocks(c.state, [...blocks, block]);
                c.state.blockIndex = currentBlocks(c.state).length - 1;
            }),
            blockEdit: guarded(editBlock),
            blockUp: guarded((c) => moveBlock(c, -1)),
            blockDown: guarded((c) => moveBlock(c, 1)),
            blockRemove: guarded(async (c) => {
                const blocks = currentBlocks(c.state);
                if (!blocks[c.state.blockIndex]) return;
                await saveBlocks(
                    c.state,
                    blocks.filter((_, i) => i !== c.state.blockIndex),
                );
            }),

            rename: guarded(rename),

            options: (c) => {
                c.state.screen = "options";
                c.state.page = 0;
            },
            addOption: guarded(async (c) => {
                const panel = currentPanel(c.state);
                if (!panel) return;
                const values = await c.modal({ title: "New option", fields: optionFields() });
                if (!values) return;
                const fields = {
                    label: parseLabel(values.label),
                    emoji: await emojiOf(values.emoji),
                    description: parseDescription(values.description),
                };
                if ((await deps.listOptions(panel.id)).length >= settings.maxOptions) {
                    throw new UserFacingError(`A panel holds up to ${settings.maxOptions} options.`);
                }
                const option = await deps.insertOption(panel.id, fields, [{ t: "title", v: fields.label }]);
                Object.assign(c.state, { optionId: option.id, screen: "page", blockIndex: 0 });
                await reload(c.state);
                await service.refresh(panel.id);
            }),
            optionUp: guarded((c) => moveOption(c, "up")),
            optionDown: guarded((c) => moveOption(c, "down")),
            deleteOption: guarded(async (c) => {
                const panel = currentPanel(c.state);
                const option = currentOption(c.state);
                if (!panel || !option) return;
                const deleted = await confirmed(c, "Delete this option?", `**${option.label}** and its page.`, () =>
                    deps.deleteOption(option.id),
                );
                if (!deleted) return;
                c.state.optionId = null;
                c.state.screen = "options";
                await reload(c.state);
                await service.refresh(panel.id);
            }),

            publish: (c) => {
                c.state.screen = "publish";
                c.state.channelId = currentPanel(c.state)?.channel_id ?? null;
            },
            channel: (c) => {
                c.state.channelId = c.values[0] ?? null;
            },
            post: guarded(async (c) => {
                const panel = currentPanel(c.state);
                const channelId = c.state.channelId ?? panel?.channel_id;
                if (!panel || !channelId) return;
                await service.publish(panel.id, channelId);
                c.state.screen = "page";
                await reload(c.state);
                await c.notify(`Posted in <#${channelId}>.`);
            }),

            deletePanel: guarded(async (c) => {
                const panel = currentPanel(c.state);
                if (!panel) return;
                const deleted = await confirmed(c, "Delete this panel?", `**${panel.name}**, its options and the posted message.`, () =>
                    service.remove(panel.id),
                );
                if (!deleted) return;
                c.state.panelId = null;
                await reload(c.state);
            }),

            back: (c) => {
                const s = c.state;
                if (s.screen === "page") {
                    s.screen = s.optionId === null ? "panels" : "options";
                    if (s.optionId === null) s.panelId = null;
                    s.optionId = null;
                } else if (s.screen === "options") {
                    s.screen = "page";
                    s.optionId = null;
                } else if (s.screen === "publish") {
                    s.screen = "page";
                }
                s.page = 0;
                s.blockIndex = 0;
            },
        },
    });

    async function moveOption(c: Ctx, direction: "up" | "down"): Promise<void> {
        const panel = currentPanel(c.state);
        const option = currentOption(c.state);
        if (!panel || !option) return;
        await deps.moveOption(panel.id, option.id, direction);
        await reload(c.state);
        await service.refresh(panel.id);
    }
}
