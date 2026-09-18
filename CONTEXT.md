# sora-bot

Discord bot framework (`src/core`, `src/config`, etc.) hosting cogs — the richest domain currently lives in the BiomeHunt cog (`src/modules/biomehunt`), a Minecraft activity-tracking game.

## Language (BiomeHunt)

**MacroChannel**:
The channel + Discord webhook pair a user's external Minecraft macro tool posts activity into. One per user per guild (`bh_user_macro_channels`).
_Avoid_: webhook channel, tracker channel

**Flower**:
A cosmetic identity (a name + image) assigned to a user's MacroChannel, drawn at random weighted by Rarity. Displayed as the MacroChannel webhook's name/avatar.
_Avoid_: skin, avatar (those are Discord-level mechanisms Flower is displayed through, not the domain concept itself)

**Rarity**:
The tier (Common/Uncommon/Rare/Epic/Legendary) that sets a Flower's draw weight. A property of the Flower's definition, not of the user or their MacroChannel.

**Reroll**:
Re-drawing a MacroChannel's Flower. A Reroll NEVER changes the MacroChannel's webhook identity (its Discord webhook id/token/URL stay exactly as they were, in every case including backfill) — it only edits that same webhook's displayed name/avatar in place. This holds because the macro tool that posts to the webhook already has that URL configured; changing it would break the user's existing setup.
_Avoid_: regenerate, recreate (those imply the webhook itself is replaced, which Reroll never does — that's what MacroChannel reset/regeneration does instead, a separate, unrelated operation)
