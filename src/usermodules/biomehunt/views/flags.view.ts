import { type ActionRowBuilder, type ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags, SeparatorSpacingSize } from "discord.js";
import {
    confirm,
    defineView,
    type HandlerContext,
    type HandlerResult,
    paginationHandlers,
    paginationRow,
    type RenderKit,
    type ViewDefinition,
    type ViewPayload,
} from "@/define";
import { EmbedFormatter } from "@/utils/format";
import { ALL_FLAGS, FLAG_DEFINITIONS } from "../constants/flags.constants";
import { setGuildFlag } from "../repository/flags.repository";
import type { FlagName } from "../types";

/** Flags per page - each takes a line, a button and up to two description lines. */
export const FLAGS_PER_PAGE = 5;

/** What the View needs that would otherwise be a DB write, injected so its tests never hit it. */
export interface FlagsDeps {
    setFlag(guildId: string, flag: FlagName, enabled: boolean): Promise<void>;
}

export const defaultFlagsDeps: FlagsDeps = { setFlag: setGuildFlag };

export interface FlagsInput {
    guildId: string;
    /** The guild's current value of every flag (`getGuildFlags`). */
    flags: Record<FlagName, boolean>;
}

interface FlagsState extends FlagsInput {
    page: number;
}

const GREEN = 0x248046;
const RED = 0xda373c;

export function flagsPageCount(): number {
    return Math.max(1, Math.ceil(ALL_FLAGS.length / FLAGS_PER_PAGE));
}

const defaultLabel = (flag: FlagName) => (FLAG_DEFINITIONS[flag].default ? "ON" : "OFF");

/** The description as `-#` lines: one, or `On:` / `Off:` when the flag explains both states. */
function descriptionLines(flag: FlagName): string {
    const def = FLAG_DEFINITIONS[flag];
    if (def.description !== undefined) return `-# ${def.description}`;
    return `-# **On:** ${def.on}\n-# **Off:** ${def.off}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The confirm's body: the flag under the title, then only the line that will apply, as a plain sentence in its own block. */
function confirmBody(flag: FlagName, enable: boolean): string[] {
    const def = FLAG_DEFINITIONS[flag];
    const applies = def.description ?? capitalize((enable ? def.on : def.off) ?? "");
    return [`**${flag}** (default: ${defaultLabel(flag)})`, applies];
}

function flagsContainer(state: FlagsState, kit: RenderKit): ContainerBuilder {
    const container = new ContainerBuilder().setAccentColor(0x5865f2);
    const addDivider = () => container.addSeparatorComponents((sep) => sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    container.addTextDisplayComponents((td) => td.setContent("**Flags**\nTurn optional features on or off for this server."));
    addDivider();

    const from = state.page * FLAGS_PER_PAGE;
    ALL_FLAGS.slice(from, from + FLAGS_PER_PAGE).forEach((flag, i) => {
        if (i > 0) addDivider();
        const on = state.flags[flag];
        container.addSectionComponents((section) =>
            section
                // The current state as an inline-code emoji, then the key and its default.
                .addTextDisplayComponents((td) => td.setContent(`\`${on ? "✅" : "❌"}\` **${flag}** (default: ${defaultLabel(flag)})`))
                .setButtonAccessory(
                    kit.button(`toggle:${flag}`, (b) =>
                        b.setLabel(on ? "Turn off" : "Turn on").setStyle(on ? ButtonStyle.Danger : ButtonStyle.Success),
                    ),
                ),
        );
        container.addTextDisplayComponents((td) => td.setContent(descriptionLines(flag)));
    });
    return container;
}

/**
 * `/bh-admin flags`: the guild's flags, five per page, each with a Turn on / Turn off button.
 * A click asks for confirmation on the same message (mobile misclicks); confirming saves the flag
 * and returns to the same page with the button flipped.
 */
export function flagsView(deps: FlagsDeps): ViewDefinition<FlagsState, void, FlagsInput> {
    const toggle =
        (flag: FlagName) =>
        async (c: HandlerContext<FlagsState, void>): Promise<HandlerResult<FlagsState>> => {
            const enable = !c.state.flags[flag];
            const { guildId } = c.state;
            const saved = await c.open(
                confirm({
                    name: "biomehunt.flags-confirm",
                    title: enable ? "Turn on this flag?" : "Turn off this flag?",
                    body: confirmBody(flag, enable),
                    color: enable ? GREEN : RED,
                    confirmLabel: enable ? "Turn on" : "Turn off",
                    confirmStyle: enable ? ButtonStyle.Success : ButtonStyle.Danger,
                    cancelLabel: "Cancel",
                    cancelStyle: ButtonStyle.Secondary,
                    onConfirm: async () => {
                        await deps.setFlag(guildId, flag, enable);
                        return EmbedFormatter.success("Saved.");
                    },
                }),
                undefined,
            );
            if (saved) c.state.flags[flag] = enable;
        };

    return defineView<FlagsState, void, FlagsInput>({
        name: "biomehunt.flags",
        initial: (input) => ({ ...input, page: 0 }),
        render: (state, kit): ViewPayload => {
            const rows: ActionRowBuilder<ButtonBuilder>[] = flagsPageCount() > 1 ? [paginationRow(kit, state.page, flagsPageCount())] : [];
            return { flags: MessageFlags.IsComponentsV2, components: [flagsContainer(state, kit), ...rows] };
        },
        on: {
            ...paginationHandlers<FlagsState>({ pages: flagsPageCount() }),
            ...Object.fromEntries(ALL_FLAGS.map((flag) => [`toggle:${flag}`, toggle(flag)])),
        },
    });
}
