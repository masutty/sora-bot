import { defineCog } from "@/define";
import _botAdminStuff from "./commands/bot.command";
import { liveFeed } from "./live-feed/live-feed";
import { liveFeedComponent } from "./live-feed/live-feed.component";

export default defineCog({
    name: "bot_internals",
    description: "Bot internals",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    commands: [_botAdminStuff],
    components: [liveFeedComponent()],
    stop: async () => {
        try {
            await liveFeed.endActive("bot stopped");
        } catch {
            // Shutdown must not fail because the feed message could not be edited.
        }
    },
});
