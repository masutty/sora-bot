import type { Message } from "discord.js";

import {
    addAuraToUser,
    getAllEnabledAuras,
} from "../repository";
import { Logger } from "@/utils/logging";

const logger = new Logger("RollingSim.AuraService");

function roll(chance: number) {
    return Math.random() < (1 / chance);
}

class AuraService {
    async process(message: Message) {
        const userId = message.author.id;
        const auras = await getAllEnabledAuras();

        for (const aura of auras) {
            if (!roll(aura.roll_chance)) continue;

            logger.info(`User ${userId} received ${aura.name}`);
            await addAuraToUser(userId, aura.id);
            return;
        }
    }

    async listAllAuras() {
        const auras = await getAllEnabledAuras();
        return auras.map((aura) => `**${aura.name}**: ${aura.description}`);
    }
}

export default new AuraService();
