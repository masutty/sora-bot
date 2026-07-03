import type {
    ActionRowBuilder,
    ButtonBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    Guild,
    GuildBasedChannel,
    Message,
    TextBasedChannel,
    User,
} from "discord.js";
import { ChannelType, GuildMember, MessageFlags, Role } from "discord.js";
import type { BotClient } from "./BotClient";
import { Logger } from "@/utils/logging";
import { config } from "@/config";

const logger = new Logger("Core.CommandContext");

// ─── Arg Schema ────────────────────────────────────────────────────────────────

export type ArgType =
    | "string"
    | "number"
    | "boolean"
    | "user"
    | "channel"
    | "role";

export interface CommandArg {
    name: string;
    description: string;
    type: ArgType;
    required: boolean;
}

// ─── Reply ─────────────────────────────────────────────────────────────────────

export interface ReplyPayload {
    content?: string;
    embeds?: EmbedBuilder[];
    ephemeral?: boolean;
    components?: ActionRowBuilder<ButtonBuilder>[];
    deleteAfter?: number; // ms
}

export interface SentMessage {
    createdTimestamp: number;
}

export interface DeferReplyOptions {
    ephemeral?: boolean; // only used for slash commands. makes the reply only visible to the user
    silent?: boolean; // only used for prefix commands. stops the automatic "processing" reply
}

// ─── Arg Helper interface ──────────────────────────────────────────────────────

export interface ArgHelper {
    getString(name: string): string | null;
    getNumber(name: string): number | null;
    getBoolean(name: string): boolean | null;
    getUser(name: string): User | null;
    getMember(name: string): GuildMember | null;
    getChannel(name: string): GuildBasedChannel | null;
    getRole(name: string): Role | null;
}

// ─── Command Context interface ─────────────────────────────────────────────────

export interface CommandContext {
    readonly user: User;
    readonly member: GuildMember | null;
    readonly guild: Guild | null;
    readonly channel: TextBasedChannel;
    readonly client: BotClient;
    readonly createdTimestamp: number;
    readonly args: ArgHelper;
    readonly source: Message | ChatInputCommandInteraction;

    reply(payload: ReplyPayload): Promise<SentMessage>;
    editReply(payload: ReplyPayload): Promise<Message>;
    deferReply(options?: DeferReplyOptions): Promise<void>;
    isSlash(): boolean;
    isPrefix(): boolean;
}

// ─── Mention / ID resolvers ────────────────────────────────────────────────────

function extractId(input: string, pattern: RegExp): string | null {
    const m = input.match(pattern);
    if (m) return m[1];
    if (/^\d{17,19}$/.test(input)) return input;
    return null;
}

function resolveUser(input: string, client: BotClient): User | null {
    const id = extractId(input, /^<@!?(\d+)>$/);
    return id ? (client.users.cache.get(id) ?? null) : null;
}

function resolveChannel(input: string, guild: Guild | null): GuildBasedChannel | null {
    const id = extractId(input, /^<#(\d+)>$/);
    return id ? (guild?.channels.cache.get(id) ?? null) : null;
}

function resolveRole(input: string, guild: Guild | null): Role | null {
    const id = extractId(input, /^<@&(\d+)>$/);
    return id ? (guild?.roles.cache.get(id) ?? null) : null;
}

// ─── Prefix Arg Helper ─────────────────────────────────────────────────────────

class PrefixArgHelper implements ArgHelper {
    constructor(
        private readonly raw: string[],
        private readonly schema: CommandArg[],
        private readonly guild: Guild | null,
        private readonly client: BotClient,
    ) { }

    private getRaw(name: string): string | null {
        const idx = this.schema.findIndex((a) => a.name === name);
        if (idx === -1) return null;
        if (idx === this.schema.length - 1 && this.raw.length > idx) {
            return this.raw.slice(idx).join(" ") || null;
        }
        return this.raw[idx] ?? null;
    }

    getString(name: string): string | null { return this.getRaw(name); }

    getNumber(name: string): number | null {
        const raw = this.getRaw(name);
        if (raw === null) return null;
        const n = Number(raw);
        return isNaN(n) ? null : n;
    }

    getBoolean(name: string): boolean | null {
        const raw = this.getRaw(name)?.toLowerCase();
        if (!raw) return null;
        if (["true", "1", "yes", "sim"].includes(raw)) return true;
        if (["false", "0", "no", "não", "nao"].includes(raw)) return false;
        return null;
    }

    getUser(name: string): User | null {
        const raw = this.getRaw(name);
        return raw ? resolveUser(raw, this.client) : null;
    }

    getMember(name: string): GuildMember | null {
        const user = this.getUser(name);
        return user ? (this.guild?.members.cache.get(user.id) ?? null) : null;
    }

    getChannel(name: string): GuildBasedChannel | null {
        const raw = this.getRaw(name);
        return raw ? resolveChannel(raw, this.guild) : null;
    }

    getRole(name: string): Role | null {
        const raw = this.getRaw(name);
        return raw ? resolveRole(raw, this.guild) : null;
    }
}

// ─── Slash Arg Helper ──────────────────────────────────────────────────────────

class SlashArgHelper implements ArgHelper {
    constructor(private readonly options: ChatInputCommandInteraction["options"]) { }

    getString(name: string): string | null { return this.options.getString(name); }
    getNumber(name: string): number | null { return this.options.getNumber(name); }
    getBoolean(name: string): boolean | null { return this.options.getBoolean(name); }
    getUser(name: string): User | null { return this.options.getUser(name); }

    getMember(name: string): GuildMember | null {
        const m = this.options.getMember(name);
        return m instanceof GuildMember ? m : null;
    }

    getChannel(name: string): GuildBasedChannel | null {
        return this.options.getChannel(name) as GuildBasedChannel | null;
    }

    getRole(name: string): Role | null {
        const r = this.options.getRole(name);
        return r instanceof Role ? r : null;
    }
}

// ─── Prefix Command Context ────────────────────────────────────────────────────

export class PrefixCommandContext implements CommandContext {
    readonly user: User;
    readonly member: GuildMember | null;
    readonly guild: Guild | null;
    readonly channel: TextBasedChannel;
    readonly client: BotClient;
    readonly createdTimestamp: number;
    readonly args: ArgHelper;
    readonly source: Message;

    private sentMessage?: Message;
    private readonly rawArgs: string[];

    constructor(message: Message, rawArgs: string[], schema: CommandArg[], client: BotClient) {
        this.user = message.author;
        this.member = message.member;
        this.guild = message.guild;
        this.channel = message.channel;
        this.client = client;
        this.createdTimestamp = message.createdTimestamp;
        this.source = message;
        this.rawArgs = rawArgs;
        this.args = new PrefixArgHelper(rawArgs, schema, message.guild, client);
    }

    isSlash(): boolean { return false; }
    isPrefix(): boolean { return true; }

    async reply(payload: ReplyPayload): Promise<Message> {
        if (this.sentMessage) {
            return this.editReply(payload);
        }
        const sent = await this.source.reply({
            content: payload.content,
            embeds: payload.embeds,
            components: payload.components as never,
        });
        this.sentMessage = sent;
        if (payload.deleteAfter) {
            setTimeout(() => sent.delete().catch(() => { }), payload.deleteAfter);
        }
        return sent;
    }

    async editReply(payload: ReplyPayload): Promise<Message> {
        if (!this.sentMessage) {
            // Ainda não respondeu — envia como reply normal
            logger.warn("Tried to edit a reply that hasn't been sent yet.");
            logger.warn("We will gracefully handle this by sending it as a reply.");
            return this.reply(payload);
        }
        const edited = await this.sentMessage.edit({
            content: payload.content ?? null,
            embeds: payload.embeds,
            components: payload.components as never,
        });
        this.sentMessage = edited;
        return edited;
    }

    async deferReply(options?: DeferReplyOptions): Promise<void> {
        if ("sendTyping" in this.channel) {
            await (this.channel as { sendTyping(): Promise<void> }).sendTyping().catch(() => { });
        }
        if (!options?.silent) {
            const sent = await this.source.reply({ content: "⏳ Processing..." });
            this.sentMessage = sent;
        }
    }

    toJSON() {
        return {
            type: "prefix" as const,
            messageId: this.source.id,
            messageContent: this.source.content,
            rawArgs: this.rawArgs,
            createdTimestamp: this.createdTimestamp,
            user: { id: this.user.id, username: this.user.username, displayName: this.user.displayName },
            member: this.member
                ? { id: this.member.id, displayName: this.member.displayName, roles: [...this.member.roles.cache.values()].map((r) => r.name) }
                : null,
            guild: this.guild
                ? { id: this.guild.id, name: this.guild.name, memberCount: this.guild.memberCount }
                : null,
            channel: {
                id: (this.channel as { id: string }).id,
                name: "name" in this.channel ? String((this.channel as { name: unknown }).name) : null,
                type: this.channel.type,
            },
            clientId: this.client.user?.id ?? null,
        };
    }
}

// ─── Slash Command Context ─────────────────────────────────────────────────────

export class SlashCommandContext implements CommandContext {
    readonly user: User;
    readonly member: GuildMember | null;
    readonly guild: Guild | null;
    readonly channel: TextBasedChannel;
    readonly client: BotClient;
    readonly createdTimestamp: number;
    readonly args: ArgHelper;
    readonly source: ChatInputCommandInteraction;

    constructor(interaction: ChatInputCommandInteraction, client: BotClient) {
        this.user = interaction.user;
        this.member = interaction.member instanceof GuildMember ? interaction.member : null;
        this.guild = interaction.guild;
        this.channel = interaction.channel as TextBasedChannel;
        this.client = client;
        this.createdTimestamp = interaction.createdTimestamp;
        this.source = interaction;
        this.args = new SlashArgHelper(interaction.options);
    }

    isSlash(): boolean { return true; }
    isPrefix(): boolean { return false; }

    async reply(payload: ReplyPayload): Promise<Message> {
        if (this.source.deferred || this.source.replied) {
            return this.editReply(payload);
        }
        const sent = await this.source.reply({
            content: payload.content,
            embeds: payload.embeds,
            components: payload.components as never,
            flags: payload.ephemeral ? MessageFlags.Ephemeral : undefined,
            fetchReply: true,
        });
        if (payload.deleteAfter) {
            setTimeout(() => this.source.deleteReply().catch(() => { }), payload.deleteAfter);
        }
        return sent as Message;
    }

    async editReply(payload: ReplyPayload): Promise<Message> {
        const edited = await this.source.editReply({
            content: payload.content,
            embeds: payload.embeds,
            components: payload.components as never,
        });
        return edited as Message;
    }

    async deferReply(options?: DeferReplyOptions): Promise<void> {
        await this.source.deferReply({ ephemeral: options?.ephemeral ?? false });
    }

    toJSON() {
        return {
            type: "slash" as const,
            interactionId: this.source.id,
            commandName: this.source.commandName,
            createdTimestamp: this.createdTimestamp,
            user: { id: this.user.id, username: this.user.username, displayName: this.user.displayName },
            member: this.member
                ? { id: this.member.id, displayName: this.member.displayName, roles: [...this.member.roles.cache.values()].map((r) => r.name) }
                : null,
            guild: this.guild
                ? { id: this.guild.id, name: this.guild.name, memberCount: this.guild.memberCount }
                : null,
            channel: {
                id: (this.channel as { id: string }).id,
                name: "name" in this.channel ? String((this.channel as { name: unknown }).name) : null,
                type: this.channel.type,
            },
            clientId: this.client.user?.id ?? null,
        };
    }
}
