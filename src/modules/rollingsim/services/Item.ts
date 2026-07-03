import type { Message } from "discord.js";

import {
    addItemToUser,
    getAllEnabledItems,
} from "../repository";
import { Logger } from "@/utils/logging";

const logger = new Logger("RollingSim.ItemService");

function roll(chance: number) {
    return Math.random() < (1 / chance);
}

class ItemService {
    async process(message: Message) {
        const userId = message.author.id;
        const items = await getAllEnabledItems();

        for (const item of items) {
            if (!roll(item.roll_chance)) continue;

            logger.info(`User ${userId} received ${item.name}`);
            await addItemToUser(userId, item.id);
        }
    }

    async listAllItems() {
        const items = await getAllEnabledItems();
        return items.map((i) => i.name);
    }
}

export default new ItemService();
