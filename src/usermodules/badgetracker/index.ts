import { defineCog } from "@/define";
import badgeTrackerCommand from "./commands/badgetracker.command";
import { BADGE_TRACKER_SCHEMA } from "./migrations";
import { pollWorker } from "./workers/poll.worker";

export default defineCog({
    name: "badge-tracker",
    description: "Posts when tracked Roblox badges get new awards.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [badgeTrackerCommand],

    migrations: [BADGE_TRACKER_SCHEMA],

    workers: [pollWorker],
});
