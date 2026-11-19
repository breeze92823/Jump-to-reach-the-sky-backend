import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const slot = { species: "toastino", variant: "golden", bank: 120 };

describe("progress", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends a saved player their progress and saves what they send back", async () => {
    const fake = fakePlayers([
      { _id: "u1", money: 5000, jumpPower: 900, slots: [slot, null], items: { box: true, jetpack: true }, equipped: "jetpack", dailyDay: 3, version: 1, updatedAt: new Date() },
    ]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u1", username: "Ann" });
    let got: any = null;
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("daily", () => {});
    c.onMessage("leaderboard", () => {});
    c.send("sync");
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.money, 5000);
    assert.deepStrictEqual(got?.slots, [slot, null]);
    assert.strictEqual(got?.equipped, "jetpack");
    assert.strictEqual(typeof got?.serverTime, "number");
    assert.strictEqual(got?.seat, 0);
    assert.ok(!("dailyDay" in got), "the daily clock travels in `daily`, not in the save");

    c.send("saveProgress", { money: 7000, jumpPower: 1200, pads: [true, false, 1], carried: [{ species: "cactuzzo", variant: "normal" }, { bad: 1 }], hack: 1, dailyDay: 99 });
    await sleep(150);
    const doc = fake.docs.get("u1")! as any;
    assert.strictEqual(doc.money, 7000);
    assert.strictEqual(doc.jumpPower, 1200);
    assert.deepStrictEqual(doc.pads, [true, false, false]);
    assert.deepStrictEqual(doc.carried, [{ species: "cactuzzo", variant: "normal" }]);
    assert.deepStrictEqual(doc.slots, [slot, null], "fields a save leaves out are kept");
    assert.strictEqual(doc.dailyDay, 3, "the server-owned daily clock is never written by a save");
    assert.strictEqual(doc.username, "Ann");
    assert.ok(!("hack" in doc));
  });

  it("creates a new account's save and never saves a guest", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "new1" });
    let none: any = null;
    c.onMessage("noProgress", (m: any) => (none = m));
    c.onMessage("daily", () => {});
    c.onMessage("leaderboard", () => {});
    c.send("sync");
    fake.release();
    await sleep(150);
    assert.ok(none);
    assert.strictEqual(none.seat, 0);
    c.send("saveProgress", { money: 10 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("new1")?.money, 10);

    const guest = await colyseus.connectTo(room, { userId: "guest-abc" });
    guest.onMessage("noProgress", () => {});
    guest.onMessage("daily", () => {});
    guest.onMessage("leaderboard", () => {});
    guest.send("sync");
    await sleep(150);
    guest.send("saveProgress", { money: 99 });
    await sleep(150);
    assert.strictEqual(fake.docs.size, 1, "a guest is never written");
    assert.strictEqual(room.state.players.get(guest.sessionId)?.signedIn, false);
  });

  it("loads the new identity when a guest signs in mid-session", async () => {
    const fake = fakePlayers([{ _id: "u2", money: 42, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-x" });
    let got: any = null;
    c.onMessage("noProgress", () => {});
    c.onMessage("progress", (m: any) => (got = m));
    c.onMessage("daily", () => {});
    c.onMessage("leaderboard", () => {});
    c.send("sync");
    fake.release();
    await sleep(150);
    c.send("identify", { userId: "u2", username: "Bea" });
    await sleep(150);
    assert.strictEqual(got?.money, 42);
    assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
  });

  it("keeps saving off when the save could not be read", async () => {
    const fake = fakePlayers([{ _id: "u3", money: 1e9, version: 1, updatedAt: new Date() }]);
    (fake as any).findOne = async () => {
      await fake.gate;
      throw new Error("down");
    };
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "u3" });
    let failed: any = null;
    c.onMessage("serverError", (m: any) => (failed = m));
    c.send("sync");
    fake.release();
    await sleep(150);
    assert.ok(failed);
    assert.strictEqual(failed.seat, 0, "the base is still assigned");
    c.send("saveProgress", { money: 0 });
    await sleep(150);
    assert.strictEqual(fake.docs.get("u3")!.money, 1e9, "the unread save is never overwritten");
  });
});
