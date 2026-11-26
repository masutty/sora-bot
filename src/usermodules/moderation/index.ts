import { defineCog } from "@/define";
import { moderationCommands } from "./commands/moderation.commands";
import { undoComponent } from "./components/undo.component";
import { MODERATION_SCHEMA } from "./migrations";
import { dueCases } from "./repository/cases.repository";
import { caseService } from "./services/runtime";
import { expiryWorker } from "./workers/expiry.worker";

export default defineCog({
    name: "moderation",
    description: "Warns, mutes, kicks, bans and temporary roles with a full audit trail.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: moderationCommands,

    components: [undoComponent()],

    migrations: [MODERATION_SCHEMA],

    workers: [expiryWorker((client) => ({ now: () => new Date(), dueCases, expire: (row) => caseService(client).expire(row) }))],
});
