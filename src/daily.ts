import { DAILY_COOLDOWN_MS, DAILY_CYCLE, DAILY_STREAK_BREAK_MS } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Daily Rewards (client src/ui/panels.js + src/game/daily.js): a 7-day cycle of one claim per
// cooldown, on the SERVER's clock so a changed device clock can't unlock anything. Waiting longer
// than the streak break restarts at Day 1. The Claim All Pass (bought with money, saved by the
// client as `dailyPass`) lets the rest of the week be claimed without waiting, and claims it all at
// once. The client never writes `dailyDay` / `dailyAt`: claims go through the `claimDaily` message
// (WorldRoom.ts) and only then does the client grant the reward.
export interface DailyState {
  day: number; // days claimed in the current streak (the cycle position is day % DAILY_CYCLE)
  at: number; // epoch ms (server clock) of the last claim, 0 = never
  pass: boolean; // Claim All Pass owned (from the saved doc / the latest saveProgress)
}

// The saved state from a player's doc (null / missing fields = a new player), bounded.
export function readDaily(doc: Partial<PlayerDoc> | null): DailyState {
  const day = Number.isInteger(doc?.dailyDay) ? Math.max(0, doc!.dailyDay!) : 0;
  const at = typeof doc?.dailyAt === "number" && Number.isFinite(doc.dailyAt) ? Math.max(0, doc.dailyAt) : 0;
  return { day, at, pass: doc?.dailyPass === true };
}

// A missed day (past the streak break) starts over at Day 1. True when the streak was reset.
export function rollStreak(s: DailyState, now = Date.now()): boolean {
  if (!s.at || s.day <= 0 || now - s.at <= DAILY_STREAK_BREAK_MS) return false;
  s.day = 0;
  return true;
}

// Milliseconds until the next claim is allowed.
export const waitMs = (s: DailyState, now = Date.now()) => (s.at ? Math.max(0, s.at + DAILY_COOLDOWN_MS - now) : 0);

// Claims the next day (or, with `all` and the pass, the rest of the week). Returns how many days
// were claimed: 0 = not allowed.
export function claimDaily(s: DailyState, all: boolean, now = Date.now()): number {
  const week = s.day % DAILY_CYCLE;
  const ready = waitMs(s, now) <= 0;
  let count = 0;
  if (all) {
    if (s.pass && (ready || week !== 0)) count = DAILY_CYCLE - week;
  } else if (ready || (s.pass && week !== 0)) count = 1;
  if (count) {
    s.day += count;
    s.at = now;
  }
  return count;
}

// What the client is sent: the clock state (it counts down from `serverTime`, not its own clock).
export function dailyView(s: DailyState, now = Date.now()) {
  return { day: s.day, at: s.at, cooldownMs: DAILY_COOLDOWN_MS, serverTime: now };
}

// The doc fields that store it.
export const dailyFields = (s: DailyState) => ({ dailyDay: s.day, dailyAt: s.at });
