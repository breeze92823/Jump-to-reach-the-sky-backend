import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { BASE_SHOWN_MAX, OUTFIT_MAX, POSE_MIN_INTERVAL_MS, POSE_SPEED_MAX, POSE_XZ_MAX, POSE_Y_MAX, POSE_Y_MIN, STACK_SHOWN_MAX } from "../src/constants.js";
import { RateGate, encodeSlots, encodeStack, sanitizeLook, sanitizeOutfit, sanitizePose } from "../src/presence.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence: sanitizePose", () => {
  it("accepts a normal pose", () => {
    const pose = sanitizePose({ x: 1.5, y: 0.05, z: -20, yaw: 1, speed: 9, grounded: true, carrying: 2 })!;
    assert.deepStrictEqual({ ...pose, yaw: Math.round(pose.yaw * 1000) / 1000 }, { x: 1.5, y: 0.05, z: -20, yaw: 1, speed: 9, grounded: true, carrying: 2 });
  });

  it("rejects what is not a pose", () => {
    for (const bad of [null, undefined, 5, "x", [1, 2, 3], {}, { x: 1, y: 2, z: 3 }, { x: NaN, y: 0, z: 0, yaw: 0 }, { x: 0, y: Infinity, z: 0, yaw: 0 }, { x: "1", y: 0, z: 0, yaw: 0 }]) {
      assert.strictEqual(sanitizePose(bad), null, JSON.stringify(bad));
    }
  });

  it("bounds the numbers", () => {
    const p = sanitizePose({ x: 1e9, y: -1e9, z: -1e9, yaw: 0, speed: 1e9, carrying: 1e9 })!;
    assert.strictEqual(p.x, POSE_XZ_MAX);
    assert.strictEqual(p.z, -POSE_XZ_MAX);
    assert.strictEqual(p.y, POSE_Y_MIN);
    assert.strictEqual(sanitizePose({ x: 0, y: 1e12, z: 0, yaw: 0 })!.y, POSE_Y_MAX);
    assert.strictEqual(p.speed, POSE_SPEED_MAX);
    assert.strictEqual(p.carrying, 32);
    assert.strictEqual(sanitizePose({ x: 0, y: 0, z: 0, yaw: 0, speed: -4 })!.speed, 0);
    assert.strictEqual(sanitizePose({ x: 0, y: 0, z: 0, yaw: 0, carrying: -3 })!.carrying, 0);
  });

  it("wraps the yaw into -PI..PI and treats odd flags as false", () => {
    const wrapped = sanitizePose({ x: 0, y: 0, z: 0, yaw: 7 * Math.PI, grounded: "yes" })!;
    assert.ok(Math.abs(Math.abs(wrapped.yaw) - Math.PI) < 1e-9);
    assert.strictEqual(wrapped.grounded, false);
    assert.ok(Math.abs(sanitizePose({ x: 0, y: 0, z: 0, yaw: -1e7 })!.yaw) <= Math.PI);
  });
});

describe("presence: outfit key, stack, slots, look", () => {
  it("keeps ids and keys, drops URLs and junk", () => {
    assert.strictEqual(sanitizeOutfit("abc_123-DEF.v2:hat=7|top=3"), "abc_123-DEF.v2:hat=7|top=3");
    for (const bad of ["https://evil.example/x.glb", "//cdn.example/x", "javascript:alert(1)", "data:text/html,x", "a b", "a<b>", "", 5, null, { a: 1 }, "x".repeat(OUTFIT_MAX + 1)]) {
      assert.strictEqual(sanitizeOutfit(bad), "", String(bad));
    }
    assert.strictEqual(sanitizeOutfit("x".repeat(OUTFIT_MAX)).length, OUTFIT_MAX);
  });

  it("encodes the carried stack bottom first and caps it", () => {
    const stack = Array.from({ length: 20 }, (_, i) => ({ species: "toastino", variant: i % 2 ? "golden" : "normal" }));
    assert.strictEqual(encodeStack(stack).split(",").length, STACK_SHOWN_MAX);
    assert.strictEqual(encodeStack([{ species: "a", variant: "lava" }, { species: "Bad Id!", variant: "x" }, null, "x", { species: "b", variant: "normal", income: 1 }]), "a:lava,b:normal");
    assert.strictEqual(encodeStack("nope"), "");
  });

  it("encodes base slots by position and trims the empty tail", () => {
    assert.strictEqual(encodeSlots([{ species: "a", variant: "normal" }, null, { species: "b", variant: "lava", bank: 5 }, null, null]), "a:normal,-,b:lava");
    assert.strictEqual(encodeSlots([null, null]), "");
    assert.strictEqual(encodeSlots(new Array(100).fill({ species: "a", variant: "normal" })).split(",").length, BASE_SHOWN_MAX);
    assert.strictEqual(encodeSlots({}), "");
  });

  it("always returns a complete look", () => {
    assert.deepStrictEqual(sanitizeLook(null), { item: "", outfit: "", stack: "", slots: "", unlocked: 0 });
    const look = sanitizeLook({ item: "rocket", outfit: "k1", stack: [{ species: "a", variant: "normal" }], slots: [null, { species: "b", variant: "golden" }], unlocked: 99.7, extra: 1 });
    assert.deepStrictEqual(look, { item: "rocket", outfit: "k1", stack: "a:normal", slots: "-,b:golden", unlocked: BASE_SHOWN_MAX });
    assert.strictEqual(sanitizeLook({ item: "has space" }).item, "");
    assert.strictEqual(sanitizeLook({ unlocked: -2 }).unlocked, 0);
  });
});

describe("presence: RateGate", () => {
  it("drops messages that come too fast", () => {
    const gate = new RateGate(100);
    assert.ok(gate.accept(1000));
    assert.ok(!gate.accept(1050));
    assert.ok(gate.accept(1100));
    assert.ok(!gate.accept(1199));
    assert.ok(gate.accept(1200));
  });
});

describe("presence: relayed through the roster", () => {
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

  it("starts unposed, then relays a bounded pose", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    await sleep(50);
    const pa = () => room.state.players.get(a.sessionId)!;
    assert.strictEqual(pa().posed, false);
    a.send("pose", { x: 3, y: 1, z: -4, yaw: 0.5, speed: 7, grounded: false, carrying: 2 });
    await sleep(80);
    assert.strictEqual(pa().posed, true);
    assert.deepStrictEqual([pa().x, pa().y, pa().z, pa().speed, pa().grounded, pa().carrying], [3, 1, -4, 7, false, 2]);
    assert.ok(Math.abs(pa().yaw - 0.5) < 1e-6);
    await sleep(POSE_MIN_INTERVAL_MS + 20);
    a.send("pose", { x: 1e12, y: NaN, z: 0, yaw: 0 }); // not a pose: ignored
    await sleep(80);
    assert.strictEqual(pa().x, 3);
    await sleep(POSE_MIN_INTERVAL_MS + 20);
    a.send("pose", { x: 1e12, y: 0, z: -1e12, yaw: 0, speed: 1e12 });
    await sleep(80);
    assert.strictEqual(pa().x, POSE_XZ_MAX);
    assert.strictEqual(pa().z, -POSE_XZ_MAX);
    assert.strictEqual(pa().speed, POSE_SPEED_MAX);
  });

  it("drops poses that arrive faster than the limit", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    await sleep(50);
    a.send("pose", { x: 1, y: 0, z: 0, yaw: 0 });
    a.send("pose", { x: 2, y: 0, z: 0, yaw: 0 }); // straight after: dropped
    a.send("pose", { x: 3, y: 0, z: 0, yaw: 0 });
    await sleep(100);
    assert.strictEqual(room.state.players.get(a.sessionId)!.x, 1);
  });

  it("relays the look and never an outfit URL", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    await sleep(50);
    const pa = () => room.state.players.get(a.sessionId)!;
    a.send("look", { item: "rocket", outfit: "kit-7:hat=2", stack: [{ species: "toastino", variant: "lava" }], slots: [{ species: "cactuzzo", variant: "golden" }, null], unlocked: 7 });
    await sleep(80);
    assert.deepStrictEqual([pa().item, pa().outfit, pa().stack, pa().slots, pa().unlocked], ["rocket", "kit-7:hat=2", "toastino:lava", "cactuzzo:golden", 7]);
    await sleep(260);
    a.send("look", { item: "", outfit: "https://evil.example/outfit.glb", stack: "x", slots: 5, unlocked: "many" });
    await sleep(80);
    assert.deepStrictEqual([pa().item, pa().outfit, pa().stack, pa().slots, pa().unlocked], ["", "", "", "", 0]);
  });

  it("keeps every player's presence apart and forgets a leaver", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await join(room, "a");
    const b = await join(room, "b");
    await sleep(50);
    a.send("pose", { x: 10, y: 0, z: 0, yaw: 0 });
    b.send("pose", { x: -10, y: 0, z: 0, yaw: 0 });
    await sleep(100);
    assert.strictEqual(room.state.players.get(a.sessionId)!.x, 10);
    assert.strictEqual(room.state.players.get(b.sessionId)!.x, -10);
    await b.leave(true);
    await sleep(150);
    assert.strictEqual(room.state.players.size, 1);
    assert.strictEqual(room.state.players.get(a.sessionId)!.x, 10);
  });
});
