import type { Message } from "discord.js";

import { addBalance } from "../repository";
import { Logger } from "@/utils/logging";

const logger = new Logger("RollingSim.CurrencyService");

class CurrencyService {
    private cooldowns = new Map<string, number>();

    private readonly COOLDOWN = 30_000;
    private readonly AMOUNT = 5;

    async process(message: Message) {
        const userId = message.author.id;

        const last = this.cooldowns.get(userId);

        if (last && Date.now() - last < this.COOLDOWN) {
            return;
        }

        this.cooldowns.set(userId, Date.now());

        logger.info(`User ${userId} received ${this.AMOUNT} currency`);
        await addBalance(userId, this.AMOUNT);
    }
}

export default new CurrencyService();
