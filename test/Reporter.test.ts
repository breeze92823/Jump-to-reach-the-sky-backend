import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setVerifierForTest } from "../src/auth.js";
import { REPORT_BATCH_MAX, SCORE_MAX } from "../src/constants.js";
import { __resetReporterForTest, __setFetchForTest, boardUserId, flushReports, reportProgress } from "../src/reporter.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

type Call = { url: string; auth: string; body: any };

describe("leaderboard reporter", () => {
  let calls: Call[];
  let ok = true;
  const env = { ...process.env };
  const fetchStub = async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok, status: ok ? 200 : 500, json: async () => ({ ok: true, accepted: 1, dropped: {} }) } as any;
  };
  beforeEach(() => {
    calls = [];
    ok = true;
    __resetReporterForTest();
    __setFetchForTest(fetchStub as any);
    process.env.BLOXITY_REPORT_TOKEN = "tok";
    process.env.BLOXITY_GAME_ID = "jump-to-reach-the-sky";
    process.env.BLOXITY_API_URL = "https://api.test";
  });
  afterEach(() => {
    __setFetchForTest(null);
    __setVerifierForTest(null);
    __setPlayersForTest(null);
    for (const k of ["BLOXITY_REPORT_TOKEN", "BLOXITY_GAME_ID", "BLOXITY_API_URL", "NODE_ENV"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it("names accounts legion_<id> and strips a mode suffix", () => {
    assert.strictEqual(boardUserId("abc"), "legion_abc");
    assert.strictEqual(boardUserId("legion_abc#m3"), "legion_abc");
  });

  it("sends the changed scores with the board declarations the first time, capped", async () => {
    reportProgress("abc", { totalEarned: 5e30, jumpPower: 12.7, rebirths: 0 });
    await flushReports();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://api.test/v1/leaderboards/hosted/jump-to-reach-the-sky/report");
    assert.strictEqual(calls[0].auth, "Bearer tok");
    assert.deepStrictEqual(
      calls[0].body.scores.sort((a: any, b: any) => a.board.localeCompare(b.board)),
      [
        { board: "jump-power", userId: "legion_abc", score: 12 },
        { board: "total-earned", userId: "legion_abc", score: SCORE_MAX },
      ],
      "no score for a zero, huge numbers are capped",
    );
    assert.deepStrictEqual(calls[0].body.boards.map((b: any) => b.id), ["total-earned", "jump-power", "rebirths"]);

    reportProgress("abc", { totalEarned: 5e30, jumpPower: 13 });
    await flushReports();
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].body.scores, [{ board: "jump-power", userId: "legion_abc", score: 13 }], "only what changed");
    assert.strictEqual(calls[1].body.boards, undefined, "the boards are declared once");
    await flushReports();
    assert.strictEqual(calls.length, 2, "nothing queued, nothing sent");
  });

  it("splits more than one batch and retries what failed", async () => {
    for (let i = 0; i < REPORT_BATCH_MAX + 50; i++) reportProgress(`u${i}`, { rebirths: 1 });
    await flushReports();
    assert.deepStrictEqual(calls.map((c) => c.body.scores.length), [REPORT_BATCH_MAX, 50]);

    calls.length = 0;
    ok = false;
    reportProgress("late", { rebirths: 4 });
    await flushReports();
    assert.strictEqual(calls.length, 1, "one attempt, then it waits for the next tick");
    ok = true;
    await flushReports();
    assert.deepStrictEqual(calls[calls.length - 1].body.scores, [{ board: "rebirths", userId: "legion_late", score: 4 }]);
  });

  it("does nothing without the report token (local development)", async () => {
    delete process.env.BLOXITY_REPORT_TOKEN;
    reportProgress("abc", { jumpPower: 5 });
    await flushReports();
    assert.strictEqual(calls.length, 0);
  });

  describe("from the room", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => await colyseus.cleanup());

    const join = async (options: object) => {
      const fake = fakePlayers();
      __setPlayersForTest(fake);
      const room = await colyseus.createRoom<WorldState>("world", {});
      const c = await colyseus.connectTo(room, options);
      for (const type of ["noProgress", "progress", "daily", "leaderboard"]) c.onMessage(type, () => {});
      c.send("sync");
      fake.release();
      await sleep(150);
      return c;
    };

    it("reports a verified account's scores when it saves, and an unverified one's never", async () => {
      process.env.NODE_ENV = "production";
      __setVerifierForTest(async (t) => (t === "good" ? { userId: "legion_abc", username: "A", pfp: "", verified: true } : null));
      const c = await join({ token: "good" });
      c.send("saveProgress", { totalEarned: 100, jumpPower: 7 });
      await sleep(150);
      await flushReports();
      assert.deepStrictEqual(
        calls.flatMap((x) => x.body.scores).map((s: any) => `${s.board}:${s.userId}:${s.score}`).sort(),
        ["jump-power:legion_abc:7", "total-earned:legion_abc:100"],
      );
    });

    it("never reports a local development id", async () => {
      process.env.NODE_ENV = "development";
      const c = await join({ userId: "dev-1" });
      c.send("saveProgress", { totalEarned: 100 });
      await sleep(150);
      await flushReports();
      assert.strictEqual(calls.length, 0);
    });
  });
});
