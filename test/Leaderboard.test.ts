import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest, type PlayerDoc } from "../src/db.js";
import { LEADERBOARD_SIZE } from "../src/constants.js";
import { __resetLeaderboardForTest } from "../src/leaderboard.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const doc = (id: string, f: Partial<PlayerDoc>): PlayerDoc => ({ _id: id, version: 1, updatedAt: new Date(), ...f });

describe("leaderboard", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetLeaderboardForTest();
  });
  afterEach(() => __setPlayersForTest(null));

  it("sends the top saved players per stat and the player's own ranks after the load", async () => {
    const seed = [
      doc("u1", { username: "Ann", totalEarned: 5e30, jumpPower: 10 }),
      doc("u2", { username: "Bo", totalEarned: 100, jumpPower: 8.79e41 }),
      ...Array.from({ length: 20 }, (_, i) => doc(`x${i}`, { username: `P${i}`, totalEarned: 1e6 + i })),
    ];
    const fake = fakePlayers(seed);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("progress", () => {});
    c.onMessage("daily", () => {});
    c.send("sync");
    fake.release();
    await sleep(200);
    assert.ok(got, "leaderboard sent after the load");
    assert.strictEqual(got.boards.totalEarned.length, LEADERBOARD_SIZE);
    assert.deepStrictEqual(got.boards.totalEarned[0], { name: "Ann", value: 5e30 });
    assert.deepStrictEqual(got.boards.jumpPower, [{ name: "Bo", value: 8.79e41 }, { name: "Ann", value: 10 }], "players without a score are left out");
    assert.deepStrictEqual(got.ranks, { totalEarned: 1, jumpPower: 2 });
  });

  it("gives a player with no save the lists and no ranks", async () => {
    const fake = fakePlayers([doc("u1", { username: "Ann", jumpPower: 3 })]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u9", username: "New" });
    let got: any = null;
    c.onMessage("leaderboard", (m: any) => (got = m));
    c.onMessage("noProgress", () => {});
    c.onMessage("daily", () => {});
    c.send("sync");
    fake.release();
    await sleep(200);
    assert.deepStrictEqual(got?.boards.jumpPower, [{ name: "Ann", value: 3 }]);
    assert.deepStrictEqual(got?.ranks, { totalEarned: null, jumpPower: null });
  });
});
