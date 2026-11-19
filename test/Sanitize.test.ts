import assert from "assert";

import { CARRY_MAX, NUMBER_MAX, SLOTS_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ money: 1e300, jumpPower: -5, totalEarned: NaN, rebirths: 3.7, speed: 20.9, smartJump: "yes", hack: "x" })!;
    assert.strictEqual(out.money, NUMBER_MAX);
    assert.strictEqual(out.jumpPower, 0);
    assert.strictEqual(out.totalEarned, undefined);
    assert.strictEqual(out.rebirths, 3);
    assert.strictEqual(out.speed, 20);
    assert.strictEqual(out.smartJump, undefined);
    assert.ok(!("hack" in out));
    assert.strictEqual(sanitizeProgress({ jumpPower: 8.79e41 })!.jumpPower, 8.79e41, "the late-game numbers fit");
  });

  it("keeps base slots by position and drops malformed brainrots", () => {
    const out = sanitizeProgress({
      slotsUnlocked: 9,
      slots: [{ species: "toastino", variant: "golden", bank: 12.5, junk: 1 }, null, { species: "Bad Id!", variant: "normal" }, { species: "solaro", variant: "lava", income: 5e9 }, "x"],
    })!;
    assert.strictEqual(out.slotsUnlocked, 9);
    assert.deepStrictEqual(out.slots, [{ species: "toastino", variant: "golden", bank: 12.5 }, null, null, { species: "solaro", variant: "lava", income: 5e9 }, null]);
    assert.strictEqual(sanitizeProgress({ slots: new Array(100).fill(null) })!.slots!.length, SLOTS_MAX);
  });

  it("bounds the carried stack and keeps flag lists as booleans", () => {
    const carried = Array.from({ length: 100 }, () => ({ species: "cactuzzo", variant: "normal", bank: 5 }));
    const out = sanitizeProgress({ carried, carryMax: 999, pads: [true, 1, false, "x"], skips: [false, true], luckyJumps: true })!;
    assert.strictEqual(out.carried!.length, CARRY_MAX);
    assert.deepStrictEqual(out.carried![0], { species: "cactuzzo", variant: "normal" }, "a carried brainrot has no bank");
    assert.strictEqual(out.carryMax, CARRY_MAX);
    assert.deepStrictEqual(out.pads, [true, false, false, false]);
    assert.deepStrictEqual(out.skips, [false, true]);
    assert.strictEqual(out.luckyJumps, true);
  });

  it("keeps the index, perks and boosts well-formed, and only equips an owned item", () => {
    const out = sanitizeProgress({
      index: { toastino: { normal: true, golden: true, bad: false }, "Bad Id!": { normal: true }, empty: {} },
      perks: { vip: true, jump15: false, "bad id": true },
      boosts: { money2: 600, lucky: -3, jump30: "x" },
      items: { box: true, jetpack: true, ghost: false },
      equipped: "jetpack",
      dailyPass: true,
      dailyMilestones: { 14: true, 28: false },
    })!;
    assert.deepStrictEqual(out.index, { toastino: { normal: true, golden: true } });
    assert.deepStrictEqual(out.perks, { vip: true });
    assert.deepStrictEqual(out.boosts, { money2: 600 });
    assert.deepStrictEqual(out.items, { box: true, jetpack: true });
    assert.strictEqual(out.equipped, "jetpack");
    assert.strictEqual(out.dailyPass, true);
    assert.deepStrictEqual(out.dailyMilestones, { 14: true });
    assert.strictEqual(sanitizeProgress({ items: { box: true }, equipped: "wings" })!.equipped, undefined);
  });

  it("never lets a save write the daily clock", () => {
    const out = sanitizeProgress({ dailyDay: 5, dailyAt: 123, money: 1 })!;
    assert.ok(!("dailyDay" in out) && !("dailyAt" in out));
  });
});
