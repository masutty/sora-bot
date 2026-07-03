import { defineCog } from "@/define";
import _botAdminStuff from "./commands/bot";

export default defineCog({
    name: "bot_internals",
    description: "Bot internals",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    commands: [_botAdminStuff],
})
