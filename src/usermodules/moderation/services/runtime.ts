import { config } from "@/config";
import type { BotClient } from "@/core/bot-client";
import * as cases from "../repository/cases.repository";
import * as settingsRepo from "../repository/settings.repository";
import { type CaseService, createCaseService } from "./case.service";
import { newCaseId } from "./case-id";
import { createDiscordDeps } from "./discord-deps";

let service: CaseService | null = null;

/** The one CaseService of this process, built on first use so the commands and the expiry worker share it. */
export function caseService(client: BotClient): CaseService {
    service ??= createCaseService({
        repo: { ...cases, ...settingsRepo },
        discord: createDiscordDeps(client),
        now: () => new Date(),
        newId: () => newCaseId(),
        isBotOwner: (userId) => config.bot.ownerIds.includes(userId),
    });
    return service;
}
