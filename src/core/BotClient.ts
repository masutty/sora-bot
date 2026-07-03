import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { Logger } from "@/utils/logging";
import { CommandRegistry } from "./CommandRegistry";
import type { ModuleDefinition } from "../types";

export class BotClient extends Client {
    public readonly commands: CommandRegistry;
    public readonly modules = new Map<string, ModuleDefinition>();
    private readonly logger = new Logger("Core.BotClient");

    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates,
            ],
            partials: [Partials.Message, Partials.Channel],
        });

        this.commands = new CommandRegistry();
        this._setupBaseListeners();
    }

    private _setupBaseListeners(): void {
        this.once(Events.ClientReady, (c) => {
            this.logger.info(`Connected as ${c.user.tag}`);
            this.logger.info(`In ${c.guilds.cache.size} guild(s)`);
        });
        this.on(Events.ShardReady, (id) => this.logger.info(`Shard ${id} ready`));
        this.on(Events.ShardDisconnect, (e, id) => this.logger.warn(`Shard ${id} disconnected (code ${e.code})`));
        this.on(Events.ShardReconnecting, (id) => this.logger.warn(`Shard ${id} reconnecting...`));
        this.on(Events.ShardResume, (id, n) => this.logger.info(`Shard ${id} resumed (${n} events replayed)`));
        this.on(Events.ShardError, (err, id) => this.logger.error(`Shard ${id} error: ${err.message}`));
        this.on(Events.Invalidated, () => this.logger.error("Session invalidated - token may be revoked"));
        this.rest.on("rateLimited", (info) => this.logger.warn(`Rate limited on ${info.method} ${info.url} - retry in ${info.timeToReset}ms`));
        this.on(Events.Error, (err) => this.logger.error(err));
        this.on(Events.Warn, (warn) => this.logger.warn(warn));
        this.on(Events.Debug, (msg) => this.logger.debug(msg));
    }
}
