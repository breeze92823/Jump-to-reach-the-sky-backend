import assert from "assert";

import { ASCENDED_LEVEL_MAX, BASE_BUILD_MS_MAX, CARRY_MAX, FUSION_MS_MAX, ZONES_MAX, LUCKY_BLOCKS_MAX, NUMBER_MAX, SLOTS_MAX } from "../src/constants.js";
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

  it("keeps Lucky Block counts whole and bounded, and the crystal count", () => {
    const out = sanitizeProgress({ luckyBlocks: { lucky: 3.9, super: -2, rainbow: 1e9, "Bad Id!": 4, junk: "x" }, crystals: 27.5 })!;
    assert.deepStrictEqual(out.luckyBlocks, { lucky: 3, rainbow: LUCKY_BLOCKS_MAX });
    assert.strictEqual(out.crystals, 27);
    assert.strictEqual(sanitizeProgress({ crystals: "9" })!.crystals, undefined);
    assert.deepStrictEqual(sanitizeProgress({ luckyBlocks: [1, 2] })!.luckyBlocks, {});
  });

  it("keeps a well-formed Fusion Machine job, clears it on null, and drops a malformed one", () => {
    const at = Date.now() + 60_000;
    const out = sanitizeProgress({ fusion: { species: "toastino", from: "normal", to: "golden", at, ms: 120_000, junk: 1 } })!;
    assert.deepStrictEqual(out.fusion, { species: "toastino", from: "normal", to: "golden", at, ms: 120_000 });
    assert.strictEqual(sanitizeProgress({ fusion: null })!.fusion, null);
    assert.ok(!("fusion" in sanitizeProgress({ fusion: { species: "Bad Id!", from: "normal", to: "golden", at, ms: 1 } })!));
    assert.ok(!("fusion" in sanitizeProgress({ fusion: "x" })!));
    const far = sanitizeProgress({ fusion: { species: "toastino", from: "normal", to: "golden", at: 1e15, ms: 1e12 } })!.fusion!;
    assert.strictEqual(far.ms, FUSION_MS_MAX);
    assert.ok(far.at <= Date.now() + FUSION_MS_MAX);
  });

  it("keeps Ascended Shop perk levels whole and bounded", () => {
    const out = sanitizeProgress({ ascended: { autoCollect: 1, mastery: 4.8, golden: 0, vault: 1e9, "Bad Id!": 2, magnet: "1" } })!;
    assert.deepStrictEqual(out.ascended, { autoCollect: 1, mastery: 4, vault: ASCENDED_LEVEL_MAX });
    assert.deepStrictEqual(sanitizeProgress({ ascended: null })!.ascended, {});
  });

  it("bounds the Base Level and its build, clearing the build on null", () => {
    const at = Date.now() + 60_000;
    const out = sanitizeProgress({ baseLevel: 3.6, baseBuild: { level: 4, at, ms: 240_000, junk: 1 } })!;
    assert.strictEqual(out.baseLevel, 3);
    assert.deepStrictEqual(out.baseBuild, { level: 4, at, ms: 240_000 });
    assert.strictEqual(sanitizeProgress({ baseBuild: null })!.baseBuild, null);
    assert.ok(!("baseBuild" in sanitizeProgress({ baseBuild: { level: "4", at, ms: 1 } })!));
    const far = sanitizeProgress({ baseLevel: 1e9, baseBuild: { level: 0, at: 1e15, ms: 1e12 } })!;
    assert.strictEqual(far.baseLevel, ZONES_MAX);
    assert.strictEqual(far.baseBuild!.level, 1);
    assert.strictEqual(far.baseBuild!.ms, BASE_BUILD_MS_MAX);
    assert.ok(far.baseBuild!.at <= Date.now() + BASE_BUILD_MS_MAX);
  });

  it("never lets a save write the daily clock", () => {
    const out = sanitizeProgress({ dailyDay: 5, dailyAt: 123, money: 1 })!;
    assert.ok(!("dailyDay" in out) && !("dailyAt" in out));
  });
});
