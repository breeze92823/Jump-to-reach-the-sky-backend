import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// A brainrot on a base slot / in the carried stack (client game.slots / game.carried).
export interface SavedBrainrot {
  species: string;
  variant: string;
  bank?: number; // money banked on the slot's collect pad (slots only)
  income?: number; // a reward brainrot's own base income
}

// A Base Level under construction: `level`, done at epoch ms `at` (client clock), `ms` long.
export interface SavedBaseBuild {
  level: number;
  at: number;
  ms: number;
}

// The Fusion Machine's job: `species` going from variant `from` to `to`, done at epoch ms `at`
// (the client's clock; the game is client-authoritative), `ms` long in total.
export interface SavedFusion {
  species: string;
  from: string;
  to: string;
  at: number;
  ms: number;
}

// The persisted client state (what `saveProgress` carries, see sanitize.ts; client
// src/game/state.js SAVED). The same document is the player's only save once signed in.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  money?: number;
  totalEarned?: number; // lifetime money earned (leaderboard)
  jumpPower?: number; // leaderboard
  rebirths?: number;
  slotsUnlocked?: number; // base pedestals bought
  slots?: (SavedBrainrot | null)[]; // brainrots placed on the base, by pedestal
  pads?: boolean[]; // AUTO TRAINING pads unlocked
  skips?: boolean[]; // Skip Wall up to zone i owned
  bestZone?: number;
  index?: Record<string, Record<string, boolean>>; // species -> { variant: found }
  perks?: Record<string, boolean>; // vip, jump15, starter...
  boosts?: Record<string, number>; // boost id -> seconds left
  smartJump?: boolean;
  carried?: SavedBrainrot[]; // brainrots held overhead, bottom first
  speed?: number; // Speed upgrade level
  carryMax?: number; // Carry upgrade: brainrots held at once
  luckyJumps?: boolean;
  items?: Record<string, boolean>; // owned back items
  equipped?: string; // the worn back item (an owned one)
  luckyBlocks?: Record<string, number>; // unopened Lucky Blocks by tier id
  crystals?: number; // Jump Crystals picked up (every 10th gives a free Lucky Block)
  fusion?: SavedFusion | null; // the Fusion Machine's running job
  ascended?: Record<string, number>; // Ascended Shop perk id -> level bought
  baseLevel?: number; // Base Level built (opens the lane walls)
  baseBuild?: SavedBaseBuild | null; // the Base Level being built
  dailyPass?: boolean; // Claim All Pass bought
  dailyMilestones?: Record<string, boolean>; // streak day -> reward claimed
  lastSeen?: number; // epoch ms of the last save (offline income counts from it)
  // Daily Rewards (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number; // days claimed in the current streak
  dailyAt?: number; // epoch ms (server clock) of the last claim
  version: number;
  updatedAt: Date;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
