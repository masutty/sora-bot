import { defineCog } from "@/define";
import panelCommand from "./commands/infopanel.command";
import { panelPickComponent } from "./components/panel-pick.component";
import { INFO_PANEL_SCHEMA } from "./migrations";

export default defineCog({
    name: "infopanel",
    description: "Admin-built panels: a select on a message that opens a page for each option.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [panelCommand],

    migrations: [INFO_PANEL_SCHEMA],

    components: [panelPickComponent()],
});
