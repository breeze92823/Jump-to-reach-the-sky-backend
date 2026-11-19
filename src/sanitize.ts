import {
  NUMBER_MAX, REBIRTHS_MAX, LEVEL_MAX, BOOST_SECONDS_MAX, SLOTS_MAX, PADS_MAX, ZONES_MAX, CARRY_MAX,
  SPECIES_MAX, VARIANTS_MAX, ITEMS_MAX, FLAGS_MAX, ID_PATTERN,
} from "./constants.js";
import type { PlayerDoc, SavedBrainrot } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// A brainrot { species, variant, bank?, income? }: slug ids, bounded numbers. Anything else is dropped.
function sanitizeBrainrot(raw: unknown): SavedBrainrot | null {
  if (!isObject(raw) || !isId(raw.species) || !isId(raw.variant)) return null;
  const out: SavedBrainrot = { species: raw.species, variant: raw.variant };
  if (finite(raw.bank)) out.bank = clampNum(raw.bank, NUMBER_MAX);
  if (finite(raw.income)) out.income = clampNum(raw.income, NUMBER_MAX);
  return out;
}

// Base pedestals: positions matter (index = pedestal), so an empty or invalid one stays null.
function sanitizeSlots(raw: unknown): (SavedBrainrot | null)[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, SLOTS_MAX).map(sanitizeBrainrot);
}

function sanitizeCarried(raw: unknown): SavedBrainrot[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedBrainrot[] = [];
  for (const c of raw) {
    if (out.length >= CARRY_MAX) break;
    const b = sanitizeBrainrot(c);
    if (b) out.push({ species: b.species, variant: b.variant, ...(b.income !== undefined && { income: b.income }) });
  }
  return out;
}

// A list of flags by position (pads, skips): booleans only, bounded length.
function sanitizeFlags(raw: unknown, max: number): boolean[] {
  return Array.isArray(raw) ? raw.slice(0, max).map((v) => v === true) : [];
}

// { id: true } maps (perks, owned items, daily milestones): slug keys, only the true ones kept.
function sanitizeFlagMap(raw: unknown, max: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObject(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= max) break;
    if (isId(id) && v === true) out[id] = true;
  }
  return out;
}

// Boost clocks { id: seconds left }: slug ids, positive bounded seconds.
function sanitizeBoosts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [id, s] of Object.entries(raw)) {
    if (Object.keys(out).length >= FLAGS_MAX) break;
    if (isId(id) && finite(s) && s > 0) out[id] = clampNum(s, BOOST_SECONDS_MAX);
  }
  return out;
}

// The Index { species: { variant: true } }: bounded species and variants per species.
function sanitizeIndex(raw: unknown): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  if (!isObject(raw)) return out;
  for (const [species, variants] of Object.entries(raw)) {
    if (Object.keys(out).length >= SPECIES_MAX) break;
    if (!isId(species)) continue;
    const found = sanitizeFlagMap(variants, VARIANTS_MAX);
    if (Object.keys(found).length) out[species] = found;
  }
  return out;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save. The Daily Reward clock
// (dailyDay / dailyAt) is deliberately NOT here: only claimDaily writes it (daily.ts).
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.money)) out.money = clampNum(raw.money, NUMBER_MAX);
  if (finite(raw.totalEarned)) out.totalEarned = clampNum(raw.totalEarned, NUMBER_MAX);
  if (finite(raw.jumpPower)) out.jumpPower = clampNum(raw.jumpPower, NUMBER_MAX);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (finite(raw.slotsUnlocked)) out.slotsUnlocked = clampInt(raw.slotsUnlocked, SLOTS_MAX);
  if (raw.slots !== undefined) out.slots = sanitizeSlots(raw.slots);
  if (raw.pads !== undefined) out.pads = sanitizeFlags(raw.pads, PADS_MAX);
  if (raw.skips !== undefined) out.skips = sanitizeFlags(raw.skips, ZONES_MAX);
  if (finite(raw.bestZone)) out.bestZone = clampInt(raw.bestZone, ZONES_MAX);
  if (raw.index !== undefined) out.index = sanitizeIndex(raw.index);
  if (raw.perks !== undefined) out.perks = sanitizeFlagMap(raw.perks, FLAGS_MAX);
  if (raw.boosts !== undefined) out.boosts = sanitizeBoosts(raw.boosts);
  if (typeof raw.smartJump === "boolean") out.smartJump = raw.smartJump;
  if (raw.carried !== undefined) out.carried = sanitizeCarried(raw.carried);
  if (finite(raw.speed)) out.speed = clampInt(raw.speed, LEVEL_MAX);
  if (finite(raw.carryMax)) out.carryMax = clampInt(raw.carryMax, CARRY_MAX, 1);
  if (typeof raw.luckyJumps === "boolean") out.luckyJumps = raw.luckyJumps;

  // Owned back items + the worn one, which must be owned (when this save carries the owned list).
  if (raw.items !== undefined) out.items = sanitizeFlagMap(raw.items, ITEMS_MAX);
  if (isId(raw.equipped) && (!out.items || out.items[raw.equipped])) out.equipped = raw.equipped;

  if (typeof raw.dailyPass === "boolean") out.dailyPass = raw.dailyPass;
  if (raw.dailyMilestones !== undefined) out.dailyMilestones = sanitizeFlagMap(raw.dailyMilestones, FLAGS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);
  return out;
}
