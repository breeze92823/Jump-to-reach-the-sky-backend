import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest, resolveIdentity } from "../src/auth.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const asProduction = () => {
  process.env.NODE_ENV = "production";
};
const realEnv = process.env.NODE_ENV; // may be undefined: restored with `delete`, never assigned
const bloxity = { userId: "legion_abc", username: "Real Name", pfp: "", verified: true };
// A stand-in for Bloxity: the token "good" belongs to legion_abc, anything else is refused.
const verifier = async (token: string) => (token === "good" ? bloxity : null);

describe("identity", () => {
  afterEach(() => {
    if (realEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realEnv;
    __setVerifierForTest(null);
    __setPlayersForTest(null);
  });

  it("uses the id Bloxity returns for a token, never the one the client sends", async () => {
    asProduction();
    __setVerifierForTest(verifier);
    const id = await resolveIdentity({ token: "good", userId: "someone-else", username: "Fake" });
    assert.deepStrictEqual(id, bloxity);
  });

  it("makes a refused token a guest, with no fallback to the client's id", async () => {
    __setVerifierForTest(verifier); // even outside production
    const id = await resolveIdentity({ token: "forged", userId: "victim-1" });
    assert.strictEqual(id.userId, "");
    assert.strictEqual(id.verified, false);
  });

  it("never trusts a client id on a production server, but does for local development", async () => {
    asProduction();
    assert.strictEqual((await resolveIdentity({ userId: "victim-1", username: "x" })).userId, "", "production: guest");
    process.env.NODE_ENV = "development";
    const dev = await resolveIdentity({ userId: "dev-1", username: "Dev" });
    assert.deepStrictEqual([dev.userId, dev.verified], ["dev-1", false]);
    assert.strictEqual((await resolveIdentity(null)).userId, "");
  });

  describe("in the room", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => await colyseus.cleanup());

    it("saves under the verified account even when the client claims another id", async () => {
      asProduction();
      __setVerifierForTest(verifier);
      const fake = fakePlayers();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { token: "good", userId: "victim-1", username: "Fake" });
      for (const type of ["noProgress", "progress", "daily", "leaderboard"]) c.onMessage(type, () => {});
      c.send("sync");
      fake.release();
      await sleep(150);
      c.send("saveProgress", { money: 5 });
      await sleep(150);
      assert.deepStrictEqual([...fake.docs.keys()], ["legion_abc"]);
      assert.strictEqual(room.state.players.get(c.sessionId)?.username, "Real Name", "the name is Bloxity's");
      assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, true);
    });

    it("treats a connection with no valid token as a guest on a production server", async () => {
      asProduction();
      __setVerifierForTest(verifier);
      const fake = fakePlayers();
      __setPlayersForTest(fake);
      fake.release();
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, { userId: "victim-1" });
      for (const type of ["noProgress", "progress", "daily", "leaderboard"]) c.onMessage(type, () => {});
      c.send("sync");
      await sleep(150);
      c.send("saveProgress", { money: 9 });
      await sleep(150);
      assert.strictEqual(fake.docs.size, 0);
      assert.strictEqual(room.state.players.get(c.sessionId)?.signedIn, false);
    });

    it("verifies the token a guest sends when signing in mid-session", async () => {
      asProduction();
      __setVerifierForTest(verifier);
      const fake = fakePlayers([{ _id: "legion_abc", money: 77, version: 1, updatedAt: new Date() }]);
      __setPlayersForTest(fake);
      fake.release();
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, {});
      let got: any = null;
      c.onMessage("noProgress", () => {});
      c.onMessage("progress", (m: any) => (got = m));
      c.onMessage("daily", () => {});
      c.onMessage("leaderboard", () => {});
      c.send("sync");
      await sleep(150);
      c.send("identify", { token: "good", userId: "victim-1" });
      await sleep(200);
      assert.strictEqual(got?.money, 77);
    });
  });
});
