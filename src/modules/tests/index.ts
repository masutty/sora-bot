import { defineCog } from "@/define";
import _test from "./commands/test";

export default defineCog({
    name: "tests",
    description: "Dev-only previews for hardcoded embeds/containers, via !test <keyword>.",
    authors: [{ name: "masutty", id: 188851299255713792n }],

    commands: [_test],
});
