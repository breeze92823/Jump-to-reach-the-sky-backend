// Keep in step with the client's src/config.js by hand (a contract change goes in both projects).

// Players per room = the number of player bases in the hub (client HUB.plots.count). Every player
// owns one base while in the room (WorldRoom assigns the seat), so a room is full when every base
// is taken. The deploy sends it to Bloxity Legion as `roomSize` (read from this line by
// .github/workflows/deploy.yml; docs.bloxity.io: send roomSize, never seatCap).
export const ROOM_MAX_CLIENTS = 6;

// The game's Bloxity slug (the client's GAME_SLUG); the deployed pod's BLOXITY_GAME_ID overrides it.
export const GAME_SLUG = "jump-to-reach-the-sky";

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules: Jump Power and money grow past 1e40 in the client's leaderboards.
export const NUMBER_MAX = 1e100; // money, totalEarned, jumpPower, a slot's bank / income
export const REBIRTHS_MAX = 1e9;
export const LEVEL_MAX = 1e6; // the Speed upgrade level
export const BOOST_SECONDS_MAX = 7 * 86_400;

// Sizes of the client's lists (src/config.js), with slack: base slots (ECONOMY.slots.total = 12),
// AUTO TRAINING pads, lane zones, the Carry upgrade, brainrot species x variants, back items.
export const SLOTS_MAX = 24;
export const PADS_MAX = 32;
export const ZONES_MAX = 64;
export const CARRY_MAX = 32;
export const SPECIES_MAX = 128;
export const VARIANTS_MAX = 16;
export const ITEMS_MAX = 128;
export const FLAGS_MAX = 32; // perks, boosts, daily milestones: small id -> value maps

// Daily Rewards (client DAILY in config.js): one claim per cooldown on the SERVER's clock; a gap
// longer than the streak break restarts at Day 1. DAILY_CYCLE = the client's DAILY.days.length.
export const DAILY_CYCLE = 7;
export const DAILY_COOLDOWN_MS = 20 * 3_600_000;
export const DAILY_STREAK_BREAK_MS = 48 * 3_600_000;

// Leaderboards (leaderboard.ts; client hub/leaders.js boards): the saved doc fields ranked
// (Total Money Earned, Highest Jump Power), rows per board (the board has 16 lines) and how often
// the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["totalEarned", "jumpPower"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 16;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (species, variants, items, perks, boosts): camelCase slugs, so
// nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";

// Bloxity's hosted leaderboards (reporter.ts): the boards the client declares with
// Legion.SDK.leaderboard.define (client config.js LEADERBOARDS: same ids, max 10, permanent once
// created) and which saved field feeds each. The server reports scores of verified accounts.
export const LEADERBOARDS = [
  { id: "total-earned", label: "Total Money Earned", stat: "totalEarned", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "jump-power", label: "Highest Jump Power", stat: "jumpPower", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "rebirths", label: "Rebirths", stat: "rebirths", order: "desc", mode: "best", format: "number", reset: "none" },
] as const;
export const LEADERBOARD_REPORT_EVERY_MS = 15 * 1000; // docs: batch every 10-30 s
export const REPORT_BATCH_MAX = 200; // scores per report call
export const SCORE_MAX = Number.MAX_SAFE_INTEGER; // Jump Power / money pass this late game; reports are capped

// Presence (presence.ts): what other players in the room see of each other. The client sends a
// `pose` ~10 times a second and a `look` when its outfit / back item / carried stack / base slots
// change; the server bounds both and relays them through the roster (PlayerState).
export const POSE_MIN_INTERVAL_MS = 40; // poses sent faster than this (~25/s) are dropped
export const LOOK_MIN_INTERVAL_MS = 200; // looks are rare; a burst of them is dropped
export const POSE_XZ_MAX = 1000; // m: the hub is 140 x 110, the lane runs north from it
export const POSE_Y_MIN = -100;
export const POSE_Y_MAX = 20_000; // the lane climbs high with late-game Jump Power
export const POSE_SPEED_MAX = 150; // m/s horizontal (a Skip Wall flight is the fastest thing)
export const OUTFIT_MAX = 256; // Bloxity outfit key (an id / key, never a URL), characters
export const STACK_SHOWN_MAX = 6; // carried brainrots other players see (the client's Carry upgrade is 5)
export const BASE_SHOWN_MAX = 12; // base pedestals other players see (client ECONOMY.slots.total)
