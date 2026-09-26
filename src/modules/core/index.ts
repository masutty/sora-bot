import { defineCog } from "@/define";
// import echoCommand from "./commands/echo.command";
import _ping from "./commands/ping.command";
import _help from "./commands/help.command";
import _setprefix from "./commands/setprefix.command";
import _echo from "./commands/echo.command";


export default defineCog({
    name: "core",
    description: "Built-in bot commands",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    // commands: [pingCommand, helpCommand, echoCommand, setprefixCommand],
    commands: [_help, _setprefix, _ping, _echo],
});
