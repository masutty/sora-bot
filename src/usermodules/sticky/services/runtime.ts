import type { BotClient } from "@/core/bot-client";
import * as limits from "../repository/limits.repository";
import * as repo from "../repository/stickies.repository";
import { createReposter, defaultRepostDeps, type Reposter } from "./repost.service";
import { createStickyService, type StickyService } from "./sticky.service";

export interface StickyRuntime {
    reposter: Reposter;
    service: StickyService;
}

let runtime: StickyRuntime | null = null;

/** The one reposter and service of this process, built on first use so the cog events and the commands share them. */
export function stickyRuntime(client: BotClient): StickyRuntime {
    if (!runtime) {
        const deps = defaultRepostDeps(client);
        const reposter = createReposter(deps);
        runtime = {
            reposter,
            service: createStickyService({ repo, limits, reposter, removeMessage: deps.remove }),
        };
    }
    return runtime;
}
