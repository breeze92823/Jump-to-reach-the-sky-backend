import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { DAILY_COOLDOWN_MS, DAILY_CYCLE, DAILY_STREAK_BREAK_MS } from "../src/constants.js";
import { claimDaily, readDaily, rollStreak, waitMs } from "../src/daily.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const T = 10 * DAILY_STREAK_BREAK_MS; // an arbitrary "now"

describe("daily reward rules", () => {
  it("lets a new player claim at once, then makes them wait out the cooldown", () => {
    const s = readDaily(null);
    assert.strictEqual(waitMs(s, T), 0);
    assert.strictEqual(claimDaily(s, false, T), 1);
    assert.deepStrictEqual([s.day, s.at], [1, T]);
    assert.strictEqual(waitMs(s, T + 1000), DAILY_COOLDOWN_MS - 1000);
    assert.strictEqual(claimDaily(s, false, T + 1000), 0, "too soon");
    assert.strictEqual(claimDaily(s, false, T + DAILY_COOLDOWN_MS), 1);
    assert.strictEqual(s.day, 2);
  });

  it("restarts the streak after the break, not before", () => {
    const s = readDaily({ dailyDay: 4, dailyAt: T });
    assert.ok(!rollStreak(s, T + DAILY_STREAK_BREAK_MS), "exactly on the limit still counts");
    assert.strictEqual(s.day, 4);
    assert.ok(rollStreak(s, T + DAILY_STREAK_BREAK_MS + 1));
    assert.strictEqual(s.day, 0);
    assert.ok(!rollStreak(readDaily(null), T), "nothing to reset for a new player");
  });

  it("the Claim All Pass skips the wait mid-week and claims the rest of the week at once", () => {
    const s = readDaily({ dailyDay: 2, dailyAt: T, dailyPass: true });
    assert.strictEqual(claimDaily(s, false, T + 1), 1, "mid-week, no wait with the pass");
    assert.strictEqual(s.day, 3);
    assert.strictEqual(claimDaily(s, true, T + 2), DAILY_CYCLE - 3);
    assert.strictEqual(s.day, DAILY_CYCLE);
    assert.strictEqual(claimDaily(s, true, T + 3), 0, "a new week still waits for the cooldown");
    assert.strictEqual(claimDaily(s, true, T + 2 + DAILY_COOLDOWN_MS), DAILY_CYCLE, "then the whole week");
    assert.strictEqual(s.day, 2 * DAILY_CYCLE);
  });

  it("refuses Claim All and mid-week skips without the pass", () => {
    const s = readDaily({ dailyDay: 2, dailyAt: T });
    assert.strictEqual(claimDaily(s, true, T + DAILY_COOLDOWN_MS), 0);
    assert.strictEqual(claimDaily(s, false, T + 1), 0);
    assert.strictEqual(readDaily({ dailyDay: -4, dailyAt: NaN } as any).day, 0);
  });
});

describe("daily reward room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends the clock on join, stores a claim and refuses the next one until the cooldown", async () => {
    const fake = fakePlayers([{ _id: "d1", dailyDay: 1, dailyAt: Date.now() - DAILY_COOLDOWN_MS - 5000, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d1" });
    let daily: any = null;
    const results: any[] = [];
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", (m: any) => (daily = m));
    c.onMessage("dailyResult", (m: any) => results.push(m));
    c.send("sync");
    fake.release();
    await sleep(150);
    assert.strictEqual(daily?.day, 1);
    assert.strictEqual(daily?.cooldownMs, DAILY_COOLDOWN_MS);
    assert.ok(daily?.at < daily?.serverTime);

    c.send("claimDaily", {});
    await sleep(150);
    assert.strictEqual(results[0]?.ok, true);
    assert.strictEqual(results[0]?.count, 1);
    assert.strictEqual(results[0]?.day, 2);
    assert.strictEqual((fake.docs.get("d1") as any).dailyDay, 2);

    c.send("claimDaily", {});
    await sleep(150);
    assert.deepStrictEqual([results[1]?.ok, results[1]?.reason], [false, "locked"]);
    assert.strictEqual((fake.docs.get("d1") as any).dailyDay, 2);

    // saveProgress can't touch the server-owned clock.
    c.send("saveProgress", { money: 1, dailyDay: 7, dailyAt: 0 });
    await sleep(150);
    assert.strictEqual((fake.docs.get("d1") as any).dailyDay, 2);
  });

  it("restarts a lapsed streak and clears its milestones", async () => {
    const fake = fakePlayers([
      { _id: "d2", dailyDay: 14, dailyAt: Date.now() - DAILY_STREAK_BREAK_MS - 5000, dailyMilestones: { 14: true }, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d2" });
    let daily: any = null;
    c.onMessage("progress", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", (m: any) => (daily = m));
    c.send("sync");
    fake.release();
    await sleep(150);
    assert.strictEqual(daily?.day, 0);
    assert.strictEqual(daily?.reset, true);
    assert.deepStrictEqual((fake.docs.get("d2") as any).dailyMilestones, {});
  });

  it("only lets the pass claim the whole week, and learns the pass from saveProgress", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "d3" });
    const results: any[] = [];
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("dailyResult", (m: any) => results.push(m));
    c.send("sync");
    fake.release();
    await sleep(150);
    c.send("claimDaily", { all: true });
    await sleep(100);
    assert.strictEqual(results[0]?.ok, false, "no pass yet");
    c.send("saveProgress", { dailyPass: true });
    await sleep(100);
    c.send("claimDaily", { all: true });
    await sleep(150);
    assert.deepStrictEqual([results[1]?.ok, results[1]?.count, results[1]?.day], [true, DAILY_CYCLE, DAILY_CYCLE]);
  });

  it("gives a guest a session-only clock", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-q" });
    let result: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("leaderboard", () => {});
    c.onMessage("daily", () => {});
    c.onMessage("dailyResult", (m: any) => (result = m));
    c.send("sync");
    await sleep(150);
    c.send("claimDaily", {});
    await sleep(150);
    assert.strictEqual(result?.ok, true);
    assert.strictEqual(fake.docs.size, 0, "a guest is never written");
  });
});
