/**
 * Merchants are finds of their own kind: separate tables and registry, but they share the forward,
 * card and casual vote with biomes. Wherever those take a biome key, a merchant is
 * `merchant:<KEY>` - a biome key is letters and digits only, so the two never collide.
 */
const PREFIX = "merchant:";

export interface MerchantMeta {
    label: string;
    color: number;
    flavorText?: string;
    iconUrl?: string;
    /** Shown before the name on its forward card and in pickers. */
    emoji?: string;
}

export interface MerchantEntry extends MerchantMeta {
    /** Uppercase letters and digits, as macro text is matched. */
    key: string;
    enabled: boolean;
}

/** The seed: inserted on boot when missing. The live list is `bh_merchants`, managed with `/owner merchant`. */
export const DEFAULT_MERCHANTS: Record<string, MerchantMeta> = {
    MARI: { label: "Mari", color: 0xffd700 },
    JESTER: { label: "Jester", color: 0x9b59b6 },
    RIN: { label: "Rin", color: 0xff8c00 },
};

const defaultEntries = (): MerchantEntry[] => Object.entries(DEFAULT_MERCHANTS).map(([key, meta]) => ({ ...meta, key, enabled: true }));

let registry = new Map(defaultEntries().map((e) => [e.key, e]));

export function setMerchantRegistry(entries: MerchantEntry[]): void {
    registry = new Map(entries.map((e) => [e.key, e]));
}

export function resetMerchantRegistry(): void {
    setMerchantRegistry(defaultEntries());
}

export const getAllMerchants = (): MerchantEntry[] => [...registry.values()];
export const getEnabledMerchants = (): MerchantEntry[] => getAllMerchants().filter((e) => e.enabled);
export const getMerchant = (key: string): MerchantEntry | undefined => registry.get(key);

export const merchantTarget = (key: string): string => `${PREFIX}${key}`;
export const isMerchantTarget = (target: string): boolean => target.startsWith(PREFIX);
/** The merchant key inside a `merchant:<KEY>` target. */
export const merchantKeyOf = (target: string): string => target.slice(PREFIX.length);
/** The entry a target names - `undefined` for a biome or a merchant no longer registered. */
export const merchantOfTarget = (target: string): MerchantEntry | undefined =>
    isMerchantTarget(target) ? getMerchant(merchantKeyOf(target)) : undefined;
