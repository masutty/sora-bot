import { defineModule } from "@/define";
import adminCommand from "./commands/admin";

export default defineModule({
    name: "admin",
    description: "Bot administration commands",
    authors: [{ name: "masutty", id: 188851299255713792n }],
    commands: [adminCommand],
});
