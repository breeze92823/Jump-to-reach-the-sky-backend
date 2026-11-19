import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room and which base (hub plot) is theirs. Durable progress lives
// in Mongo (src/db.ts). To sync something new about a player, add a field here and accept it in a
// WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none)
    // The player's base in the hub (client HUB.plots, west -> east): 0 .. ROOM_MAX_CLIENTS - 1,
    // unique within the room. The room holds exactly as many players as there are bases.
    seat: t.int8().default(0),

    // --- Presence (src/presence.ts): what other players see of this one. Set from the player's own
    // `pose` / `look` messages, bounded; a client draws a remote avatar from it once `posed`.
    posed: t.boolean().default(false), // the first pose arrived (until then x / y / z mean nothing)
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    yaw: t.float32().default(0), // radians the character faces
    speed: t.float32().default(0), // horizontal m/s (walk / run animation)
    grounded: t.boolean().default(true),
    carrying: t.int8().default(0), // brainrots held overhead (arms-up pose)
    item: t.string().default(""), // equipped back item id ("" = none)
    outfit: t.string().default(""), // Bloxity outfit key (an id, never a URL)
    stack: t.string().default(""), // carried brainrots "species:variant,..." (bottom first)
    slots: t.string().default(""), // base pedestals "species:variant,-,..." ("-" = empty)
    unlocked: t.int8().default(0), // base pedestals bought
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
