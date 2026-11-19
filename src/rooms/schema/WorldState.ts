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
