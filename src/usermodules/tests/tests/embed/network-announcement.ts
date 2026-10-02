import { MessageFlags } from "discord.js";
import { buildAnnouncementContainer } from "@/usermodules/biomehunt/services/network-announce.service";
import { NO_PINGS } from "@/utils/format";
import type { TestCase, TestPayload } from "../../registry";

/**
 * The Network announcement card (`/bh-owner network announce`), as a Member Server sees it - page 1
 * with that server's announcements role pinged on top, page 2 without one. Fake data; pings nobody.
 */
const FAKE_ROLE_ID = "1";
const SAMPLE =
    "The Network will be down for maintenance tonight from **22:00 to 22:30 UTC**.\n" +
    "Rare biomes found in that window stay local. Thanks for hunting with us!";

function page(roleId: string | null): TestPayload {
    return { flags: MessageFlags.IsComponentsV2, components: [buildAnnouncementContainer(SAMPLE, roleId)], allowedMentions: NO_PINGS };
}

export default {
    description: "The Network announcement card - with and without the server's announcements role ping.",
    pages: () => [page(FAKE_ROLE_ID), page(null)],
} satisfies TestCase;
