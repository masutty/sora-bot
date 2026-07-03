import { defineModule } from "@/define";
import { CommandCategory } from "@/types";
import pingCommand from "./commands/ping";
import helpCommand from "./commands/help";
import echoCommand from "./commands/echo";
import setprefixCommand from "./commands/setprefix";

export default defineModule({
    name: "core",
    description: "Built-in bot commands",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    commands: [pingCommand, helpCommand, echoCommand, setprefixCommand],
});
