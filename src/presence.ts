import {
  BASE_SHOWN_MAX, CARRY_MAX, ID_PATTERN, OUTFIT_MAX, POSE_SPEED_MAX, POSE_XZ_MAX, POSE_Y_MAX, POSE_Y_MIN,
  SLOTS_MAX, STACK_SHOWN_MAX,
} from "./constants.js";

// Presence: the bounded, relayable part of what a client says about itself. The game is
// client-authoritative, so nothing here is "validated" against rules, only made safe to relay:
// finite, in range, short, and made of ids (never URLs) so one client cannot make another one load
// something or draw something absurd.

/** Where a player is and what its body is doing (client `player`, ~10 times a second). */
export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number; // radians, -PI..PI, the way the character faces
  speed: number; // horizontal m/s, drives the walk / run animation
  grounded: boolean;
  carrying: number; // brainrots held overhead (the arms-up pose)
}

/** What a player looks like and owns on show; changes rarely. Strings are the wire form (see below). */
export interface Look {
  item: string; // equipped back item id, "" = none
  outfit: string; // Bloxity outfit key, "" = none / unknown
  stack: string; // carried brainrots "species:variant,..." (bottom first, at most STACK_SHOWN_MAX)
  slots: string; // base pedestals "species:variant,-,species:variant..." ("-" = empty), by pedestal
  unlocked: number; // base pedestals bought
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bounds a client pose, or null when it is not one (anything non-finite / non-object). */
export function sanitizePose(raw: unknown): Pose | null {
  if (!isObject(raw)) return null;
  const { x, y, z, yaw, speed } = raw;
  if (!num(x) || !num(y) || !num(z) || !num(yaw)) return null;
  const turns = ((yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // -PI..PI
  return {
    x: clamp(x, -POSE_XZ_MAX, POSE_XZ_MAX),
    y: clamp(y, POSE_Y_MIN, POSE_Y_MAX),
    z: clamp(z, -POSE_XZ_MAX, POSE_XZ_MAX),
    yaw: turns,
    speed: num(speed) ? clamp(speed, 0, POSE_SPEED_MAX) : 0,
    grounded: raw.grounded === true,
    carrying: num(raw.carrying) ? clamp(Math.floor(raw.carrying), 0, CARRY_MAX) : 0,
  };
}

/** A Bloxity outfit key: an opaque id / key. Letters, digits and a few separators, at most
 * OUTFIT_MAX long. "/", "?", "#", "%" and spaces are not allowed, so it can never be a fetchable URL:
 * "" when it is anything else. */
export function sanitizeOutfit(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > OUTFIT_MAX) return "";
  return /^[A-Za-z0-9_.,:;|~=+\-]+$/.test(raw) ? raw : "";
}

// A brainrot on the wire: "species:variant" (both ids, so neither contains ":" or ",").
const pair = (b: unknown): string | null => (isObject(b) && isId(b.species) && isId(b.variant) ? `${b.species}:${b.variant}` : null);

/** The carried stack, bottom first, as "species:variant,..." (malformed entries dropped). */
export function encodeStack(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const out: string[] = [];
  for (const b of raw) {
    if (out.length >= STACK_SHOWN_MAX) break;
    const s = pair(b);
    if (s) out.push(s);
  }
  return out.join(",");
}

/** The base pedestals by position as "species:variant" or "-" for an empty / invalid one; trailing
 * empty pedestals are cut. */
export function encodeSlots(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const out = raw.slice(0, Math.min(SLOTS_MAX, BASE_SHOWN_MAX)).map((b) => pair(b) ?? "-");
  while (out.length && out[out.length - 1] === "-") out.pop();
  return out.join(",");
}

/** Bounds a client look; absent / malformed parts become empty. Always returns a complete Look. */
export function sanitizeLook(raw: unknown): Look {
  const r = isObject(raw) ? raw : {};
  return {
    item: isId(r.item) ? r.item : "",
    outfit: sanitizeOutfit(r.outfit),
    stack: encodeStack(r.stack),
    slots: encodeSlots(r.slots),
    unlocked: num(r.unlocked) ? clamp(Math.floor(r.unlocked), 0, BASE_SHOWN_MAX) : 0,
  };
}

/** Drops messages that arrive faster than `minMs` apart (per player). */
export class RateGate {
  private last = -Infinity;
  constructor(private readonly minMs: number) {}
  accept(now: number): boolean {
    if (now - this.last < this.minMs) return false;
    this.last = now;
    return true;
  }
}
