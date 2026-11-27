import { getAllMerchants, getMerchant, type MerchantEntry, type MerchantMeta } from "../constants/merchants.constants";
import { insertMerchant, loadMerchantRegistry, setMerchantEnabled, updateMerchant } from "../repository/merchants.repository";
import { BiomeHuntError } from "../types";
import { biomeKeyFor, CLEAR_VALUE, parseBadgeEmoji, parseFlavorText, parseHexColor, parseIconUrl, parseLabel } from "./biome-admin.service";

export interface MerchantAdminDeps {
    insertMerchant: typeof insertMerchant;
    updateMerchant: typeof updateMerchant;
    setMerchantEnabled: typeof setMerchantEnabled;
    reloadRegistry: typeof loadMerchantRegistry;
}

export const defaultMerchantAdminDeps = (): MerchantAdminDeps => ({
    insertMerchant,
    updateMerchant,
    setMerchantEnabled,
    reloadRegistry: loadMerchantRegistry,
});

/** The fields an add or edit can give. `null` = not given; `CLEAR_VALUE` removes an optional one. */
export interface MerchantChanges {
    name: string | null;
    color: string | null;
    flavorText: string | null;
    iconUrl: string | null;
    emoji: string | null;
}

export const NO_MERCHANT_CHANGES: MerchantChanges = { name: null, color: null, flavorText: null, iconUrl: null, emoji: null };

function optional(current: string | undefined, input: string | null, parse: (raw: string) => string): string | undefined {
    if (input === null) return current;
    return input.trim().toLowerCase() === CLEAR_VALUE ? undefined : parse(input);
}

function apply(current: MerchantMeta, changes: MerchantChanges): MerchantMeta {
    return {
        label: changes.name === null ? current.label : parseLabel(changes.name),
        color: changes.color === null ? current.color : parseHexColor(changes.color),
        flavorText: optional(current.flavorText, changes.flavorText, parseFlavorText),
        iconUrl: optional(current.iconUrl, changes.iconUrl, parseIconUrl),
        emoji: optional(current.emoji, changes.emoji, parseBadgeEmoji),
    };
}

export function requireMerchant(input: string): MerchantEntry {
    const wanted = input.trim().toLowerCase();
    const found = getMerchant(input) ?? getAllMerchants().find((m) => m.label.toLowerCase() === wanted || m.key.toLowerCase() === wanted);
    if (!found) throw new BiomeHuntError(`\`${input}\` is not a registered merchant.`);
    return found;
}

/** Registers a merchant under the name macros write - recognized and offered right away. */
export async function addMerchant(
    changes: MerchantChanges & { name: string; color: string },
    deps: MerchantAdminDeps = defaultMerchantAdminDeps(),
): Promise<MerchantEntry> {
    const key = biomeKeyFor(changes.name);
    const meta = apply({ label: parseLabel(changes.name), color: 0 }, changes);
    if (!(await deps.insertMerchant(key, meta))) throw new BiomeHuntError(`The merchant \`${key}\` already exists.`);
    await deps.reloadRegistry();
    return { ...meta, key, enabled: true };
}

export async function editMerchant(
    merchant: string,
    changes: MerchantChanges,
    deps: MerchantAdminDeps = defaultMerchantAdminDeps(),
): Promise<MerchantEntry> {
    const current = requireMerchant(merchant);
    if (Object.values(changes).every((v) => v === null)) throw new BiomeHuntError("Give at least one field to change.");
    const meta = apply(current, changes);
    await deps.updateMerchant(current.key, meta);
    await deps.reloadRegistry();
    return { ...meta, key: current.key, enabled: current.enabled };
}

export async function setMerchantActive(
    merchant: string,
    enabled: boolean,
    deps: MerchantAdminDeps = defaultMerchantAdminDeps(),
): Promise<MerchantEntry> {
    const current = requireMerchant(merchant);
    await deps.setMerchantEnabled(current.key, enabled);
    await deps.reloadRegistry();
    return { ...current, enabled };
}
