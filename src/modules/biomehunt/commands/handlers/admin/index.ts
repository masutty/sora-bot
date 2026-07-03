import statusGreen from "./config/status-green";
import statusYellow from "./config/status-yellow";
import statusRed from "./config/status-red";
import resetConfig from "./config/reset";
import showConfig from "./config/show";
import macroCategory from "./config/macro-category";

import userView from "./user/view";
import userReset from "./user/reset";
import userResetChannel from "./user/reset-channel";
import userResetWebhook from "./user/reset-webhook";
import { AdminCommandModule } from "@/modules/biomehunt/types";

type AdminRegistry = Record<
    string,
    Record<string, AdminCommandModule>
>;

export const adminRegistry: AdminRegistry = {
    config: {
        "status-green": statusGreen,
        "status-yellow": statusYellow,
        "status-red": statusRed,
        "reset": resetConfig,
        "show": showConfig,
        "macro-category": macroCategory,
    },

    user: {
        "view": userView,
        "reset": userReset,
        "reset-channel": userResetChannel,
        "reset-webhook": userResetWebhook,
    },
};
