import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { ROOM_MAX_CLIENTS } from "../src/constants.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// The room holds exactly as many players as the hub has bases (client HUB.plots.count), and every
// player gets their own base (`seat`).
describe("base seats", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  const join = async (room: any, userId: string) => {
    const c = await colyseus.connectTo(room, { userId, username: userId });
    for (const type of ["noProgress", "progress", "daily", "leaderboard"]) c.onMessage(type, () => {});
    c.send("sync");
    return c;
  };

  it("is as big as the hub has bases", () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, 6, "client HUB.plots.count");
  });

  it("gives every player a different base and tells them which", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    assert.strictEqual(room.maxClients, ROOM_MAX_CLIENTS);
    const answers: number[] = [];
    for (let i = 0; i < ROOM_MAX_CLIENTS; i++) {
      const c = await colyseus.connectTo(room, { userId: `s${i}` });
      c.onMessage("noProgress", (m: any) => answers.push(m.seat));
      c.onMessage("daily", () => {});
      c.onMessage("leaderboard", () => {});
      c.send("sync");
    }
    await sleep(200);
    const seats = [...room.state.players.values()].map((p) => p.seat).sort();
    assert.deepStrictEqual(seats, [0, 1, 2, 3, 4, 5]);
    assert.deepStrictEqual([...answers].sort(), [0, 1, 2, 3, 4, 5]);
  });

  it("refuses a seventh player", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    for (let i = 0; i < ROOM_MAX_CLIENTS; i++) await join(room, `f${i}`);
    await assert.rejects(() => colyseus.connectTo(room, { userId: "extra" }));
    assert.strictEqual(room.state.players.size, ROOM_MAX_CLIENTS);
  });

  it("hands a freed base to the next player", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    const b = await join(room, "b");
    await join(room, "c");
    await sleep(100);
    const seatOf = (c: any) => room.state.players.get(c.sessionId)!.seat;
    assert.deepStrictEqual([seatOf(a), seatOf(b)], [0, 1]);
    await b.leave(true);
    await sleep(150);
    const d = await join(room, "d");
    await sleep(100);
    assert.strictEqual(seatOf(d), 1, "b's base is free again");
    assert.strictEqual(seatOf(a), 0, "the others keep theirs");
  });

  it("keeps a reloading player's base", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    const b = await join(room, "b");
    await join(room, "c");
    await sleep(100);
    const seatOf = (c: any) => room.state.players.get(c.sessionId)!.seat;
    assert.strictEqual(seatOf(b), 1);
    // Same account again (its old connection has not timed out yet): the old session is dropped and
    // the new one gets the same base, not the next free one.
    const b2 = await join(room, "b");
    await sleep(150);
    assert.strictEqual(seatOf(b2), 1);
    assert.strictEqual(seatOf(a), 0);
    assert.strictEqual(room.state.players.size, 3, "the old session is gone");
  });
});
