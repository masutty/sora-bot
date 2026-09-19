import { defineCog } from "@/define";
// import echoCommand from "./commands/echo";
import _ping from "./commands/ping";
import _help from "./commands/help";
import _setprefix from "./commands/setprefix";
import _echo from "./commands/echo";


export default defineCog({
    name: "core",
    description: "Built-in bot commands",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    // commands: [pingCommand, helpCommand, echoCommand, setprefixCommand],
    commands: [_help, _setprefix, _ping, _echo],
});
