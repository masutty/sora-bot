import type { Message } from "discord.js";

import { ensureProfile } from "../repository";

import CurrencyService from "./Currency";
import AuraService from "./Aura";
import ItemService from "./Item";

export class RollingService {
    async process(message: Message) {
        const userId = message.author.id;

        await ensureProfile(userId);

        await Promise.all([
            CurrencyService.process(message),
            AuraService.process(message),
            ItemService.process(message),
        ]);
    }
}

export default new RollingService();
