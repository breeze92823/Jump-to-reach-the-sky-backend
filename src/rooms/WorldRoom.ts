import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, LOOK_MIN_INTERVAL_MS, NAME_MAX, POSE_MIN_INTERVAL_MS, PFP_MAX_LEN, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { RateGate, sanitizeLook, sanitizePose } from "../presence.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollStreak, type DailyState } from "../daily.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { resolveIdentity, type Identity } from "../auth.js";
import { flushReports, reportProgress, startReporter } from "../reporter.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. It holds as
 * many players as the hub has bases (ROOM_MAX_CLIENTS): each joiner is given a free base, its
 * `seat`, which the client builds as its own (src/hub/plots.js). Loads and saves each signed-in
 * player's progress (MongoDB, see db.ts). The game is client-authoritative: no gameplay rules live
 * here, saves are only bounded (sanitize.ts) -- except the Daily Reward clock (daily.ts). Full
 * rooms spill into a fresh one automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionIds whose current identity was verified by Bloxity (auth.ts): only these appear on
  // Bloxity's hosted leaderboards (reporter.ts).
  private verified = new Set<string>();
  // sessionId -> Daily Rewards state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();

  // sessionId -> rate limits of the presence messages (presence.ts).
  private poseGates = new Map<string, RateGate>();
  private lookGates = new Map<string, RateGate>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      // The Claim All Pass decides what claimDaily allows, even for sessions that are not stored.
      const daily = this.dailies.get(client.sessionId);
      if (daily && patch.dailyPass !== undefined) daily.pass = patch.dailyPass;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...patch, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
        if (this.verified.has(client.sessionId)) reportProgress(userId, patch);
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Claims the next Daily Reward day, or with `all` the rest of the week (needs the pass). The
    // server decides on its own clock: answers `dailyResult` { ok, count, reset, ...view }; the
    // client only grants the reward(s) on ok.
    claimDaily: async (client: Client, msg: { all?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, reason: "loading" });
      const all = msg?.all === true;
      const before = { ...s };
      const reset = rollStreak(s);
      const count = claimDaily(s, all);
      if (!count) {
        if (reset) void this.saveDaily(client.sessionId, s, true);
        return client.send("dailyResult", { ok: false, reason: "locked", reset, ...dailyView(s) });
      }
      if (!(await this.saveDaily(client.sessionId, s, reset))) {
        Object.assign(s, before); // not stored: not claimed
        return client.send("dailyResult", { ok: false, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, count, reset, ...dailyView(s) });
    },
    // Where the player is and what its body is doing, ~10/s (presence.ts). Bounded, rate-limited,
    // then relayed through the roster so everyone else can draw it.
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const gate = this.poseGates.get(client.sessionId);
      if (!p || !gate?.accept(Date.now())) return;
      const pose = sanitizePose(msg);
      if (!pose) return;
      p.x = pose.x;
      p.y = pose.y;
      p.z = pose.z;
      p.yaw = pose.yaw;
      p.speed = pose.speed;
      p.grounded = pose.grounded;
      p.carrying = pose.carrying;
      p.posed = true;
    },
    // What the player looks like and has on show (back item, outfit key, carried stack, base
    // pedestals), sent when it changes.
    look: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const gate = this.lookGates.get(client.sessionId);
      if (!p || !gate?.accept(Date.now())) return;
      const look = sanitizeLook(msg);
      p.item = look.item;
      p.outfit = look.outfit;
      p.stack = look.stack;
      p.slots = look.slots;
      p.unlocked = look.unlocked;
    },
    // The client's handlers are registered: answer with its base (`seat`) and progress /
    // noProgress / serverError, then `daily` and `leaderboard`. Anything the server sends from
    // onJoin itself can arrive before the client's handlers exist and is dropped, so the first
    // answer waits for this message. Also sent again after every reconnect.
    sync: (client: Client) => {
      const p = this.state.players.get(client.sessionId);
      if (p) void this.loadProgress(client, this.userIds.get(client.sessionId) ?? "", p);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: async (client: Client, msg: { token?: string; username?: string; userId?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const id = await resolveIdentity(msg);
      if (this.state.players.get(client.sessionId) !== p) return; // left meanwhile
      this.applyIdentity(client, p, id);
    },
  };

  // Names the player from the identity (Bloxity's own name when verified, else what the client
  // said) and, when the account changed, loads its progress.
  private applyIdentity(client: Client, p: PlayerState, id: Identity, answer = true): number | undefined {
    if (id.username) p.username = sanitizeName(id.username);
    if (id.pfp) p.pfp = sanitizePfp(id.pfp);
    if (id.verified) this.verified.add(client.sessionId);
    else this.verified.delete(client.sessionId);
    return this.setUserId(client, p, id.userId, answer);
  }

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    startReporter(); // Bloxity leaderboard reports (a no-op without BLOXITY_REPORT_TOKEN)
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
  }

  // `leaderboard` { boards: { totalEarned|jumpPower: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  // The lowest base nobody else in this room holds. maxClients = the number of bases, so one is free
  // for every player that gets in (a dropped player keeps theirs for the reconnect window).
  private freeSeat(except?: PlayerState): number {
    const taken = new Set<number>();
    this.state.players.forEach((q) => {
      if (q !== except) taken.add(q.seat);
    });
    let seat = 0;
    while (taken.has(seat)) seat++;
    return seat;
  }

  // `options` carries the client's Bloxity `token` (verified here: auth.ts) -- a user id it sends is
  // only used by a local development server.
  async onJoin(client: Client, options?: { token?: string; username?: string; userId?: string; pfp?: string }) {
    const id = await resolveIdentity(options);
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    this.state.players.set(client.sessionId, p);
    this.poseGates.set(client.sessionId, new RateGate(POSE_MIN_INTERVAL_MS));
    this.lookGates.set(client.sessionId, new RateGate(LOOK_MIN_INTERVAL_MS));
    // Identity only: the answer (seat, progress...) goes out on the client's `sync`. A signed-in
    // account that is already here (a reload, a reconnect the old connection hasn't timed out
    // yet) takes over that session's base, so reloading never moves a player's base.
    const inherited = this.applyIdentity(client, p, id, false);
    p.seat = inherited ?? this.freeSeat(p);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session
  // (and so the same base).
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      void flushReports();
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      this.forgetSession(client.sessionId);
      void flushReports();
    }
  }

  // Server-clock "last seen" for a player who has really gone: the offline income counts from it.
  // Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping (and frees its base).
  private forgetSession(sessionId: string) {
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.verified.delete(sessionId);
    this.dailies.delete(sessionId);
    this.poseGates.delete(sessionId);
    this.lookGates.delete(sessionId);
  }

  // Stores a session's Daily Rewards clock (and, when the streak restarted, clears the milestones
  // it had unlocked). True when stored, or when there is nowhere to store it (guest / no database:
  // it lives in `dailies` for the session).
  private async saveDaily(sessionId: string, s: DailyState, resetMilestones = false): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { ...dailyFields(s), ...(resetMilestones && { dailyMilestones: {} }), updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveDaily failed", err);
      return false;
    }
  }

  // Client-trusted Bloxity user id (guest ids are dropped, see GUEST_ID_PREFIX). A forged id can
  // only read/overwrite the SENDER's own save (there is no cross-player read in `saveProgress`).
  // Called from both onJoin (`answer` false: the client asks with `sync`) and `identify`, which
  // answers with progress / noProgress / serverError at once.
  private setUserId(client: Client, p: PlayerState, raw: string, answer = true): number | undefined {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return undefined;
    let inheritedSeat: number | undefined; // the seat of the session this one replaces
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        inheritedSeat ??= this.state.players.get(sid)?.seat;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    if (answer) void this.loadProgress(client, userId, p);
    return inheritedSeat;
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  // Every answer carries the client's base (`seat`) and the server clock (`serverTime`).
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", { seat: p.seat });
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    const answer = { seat: p.seat, serverTime: now };
    if (!doc) client.send("noProgress", answer);
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), ...answer });

    // Daily Rewards: a streak that lapsed restarts, then the client gets the clock.
    const reset = rollStreak(daily, now);
    if (reset) await this.saveDaily(client.sessionId, daily, true);
    if (this.dailies.get(client.sessionId) === daily) client.send("daily", { reset, ...dailyView(daily) });
    void this.sendLeaderboard(client);
  }
}
