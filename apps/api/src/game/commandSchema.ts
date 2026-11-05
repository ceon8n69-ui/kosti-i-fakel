import { z } from "zod";

const id = z.string().min(1).max(40);
const die = z.number().int().min(0).max(2);
const dice = z.array(die).min(1).max(3);

/** Команда игрока в том виде, в каком её присылает клиент. actorId подставляет сервер. */
export const ClientCommandSchema = z.intersection(
  z.object({
    commandId: z.string().min(8).max(64),
    expectedSeq: z.number().int().nonnegative(),
  }),
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("MOVE"), heroId: id, x: z.number().int().min(0).max(31), y: z.number().int().min(0).max(31) }),
    z.object({ type: z.literal("INTERACT"), heroId: id, objectId: id, verb: z.enum(["use", "force", "disarm"]) }),
    z.object({ type: z.literal("SEARCH"), heroId: id }),
    z.object({ type: z.literal("REST"), heroId: id, objectId: id }),
    z.object({ type: z.literal("RETREAT"), heroId: id }),
    z.object({ type: z.literal("USE_ITEM"), heroId: id, itemId: id, targetId: id.optional() }),
    z.object({ type: z.literal("CHANGE_ROW"), heroId: id, row: z.enum(["front", "back"]) }),
    z.object({ type: z.literal("ROLL_DICE"), heroId: id }),
    z.object({ type: z.literal("REROLL"), heroId: id, dice }),
    z.object({ type: z.literal("USE_FATE_DEBT"), heroId: id, dice }),
    z.object({
      type: z.literal("ASSIGN_FACE"),
      heroId: id,
      die,
      target: id.nullable(),
      star: z.number().int().min(0).max(5).optional(),
    }),
    z.object({ type: z.literal("READY"), heroId: id, ready: z.boolean() }),
  ]),
);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export const CreateHeroSchema = z.object({
  classId: z.enum(["guardian", "rogue", "sorcerer", "healer"]),
  name: z.string().trim().min(1).max(24).optional(),
});

export const CreateSessionSchema = z.object({
  heroId: z.string().uuid(),
  dungeonId: z.string().regex(/^[a-z0-9_]{1,32}$/),
});
