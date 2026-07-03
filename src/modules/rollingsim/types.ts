/* ───────────────────────────────────────────── */
/* Database entities                            */
/* ───────────────────────────────────────────── */

export interface RollingProfile {
    user_id: string;
    balance: number;
    created_at: Date;
}


export interface RollingItem {
    id: number;
    name: string;
    description: string | null;
    // 1/x chance
    roll_chance: number;
    enabled: boolean;
    created_at: Date;
}


export interface RollingAura {
    id: number;
    name: string;
    description: string | null;
    // 1/x chance
    roll_chance: number;
    enabled: boolean;
    created_at: Date;
}


export interface UserItem {
    user_id: string;
    item_id: number;
    quantity: number;
}


export interface UserAura {
    id: number;
    user_id: string;
    aura_id: number;
    obtained_at: Date;
}


/* ───────────────────────────────────────────── */
/* Joined query results                         */
/* ───────────────────────────────────────────── */

export interface UserItemWithName extends UserItem {
    name: string;
}


export interface UserAuraWithName extends UserAura {
    name: string;
}


/* ───────────────────────────────────────────── */
/* Runtime roll results                         */
/* ───────────────────────────────────────────── */

export interface CurrencyRewardResult {
    amount: number;
}


export interface AuraRewardResult {
    aura: RollingAura;
}


export interface ItemRewardResult {
    items: RollingItem[];
}


export interface ProcessMessageResult {
    currency: CurrencyRewardResult | null;
    aura: AuraRewardResult | null;
    items: ItemRewardResult | null;
}


/* ───────────────────────────────────────────── */
/* Optional future enums                        */
/* ───────────────────────────────────────────── */

export enum RewardType {
    ITEM = "item",
    AURA = "aura",
    CURRENCY = "currency",
}
