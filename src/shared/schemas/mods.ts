import { z } from 'zod';

const id = z.coerce.number().int().positive();

/** Longest mod id the `/:modId` routes can address (Fastify's default maxParamLength), so an id created can always be edited or removed. */
export const MOD_ID_MAX = 100;
/** Longest reason accepted by every route that writes one. */
export const REASON_MAX = 500;

/** Id of an existing mod or entry (path params, edit, delete): bounded but not trimmed, so legacy blank or padded rows stay removable. */
export const ModIdSchema = z.string().min(1).max(MOD_ID_MAX);
/** Id on create: same bounds, but no blank id and no leading or trailing whitespace. */
export const NewModIdSchema = ModIdSchema.refine((s) => s === s.trim() && s.length > 0, { message: 'must not be blank or start or end with whitespace' });
export const ReasonSchema = z.string().max(REASON_MAX);

export const DiffQuerySchema = z.object({ base: id, other: id });
export const UpstreamSidesQuerySchema = z.object({ server: id, client: id });
export const AnomaliesQuerySchema = z.object({ upstreamClient: id, own: id });
export const LoaderCheckQuerySchema = z.object({ profiles: z.string().regex(/^\d+(,\d+)*$/) });
export const BlacklistQuerySchema = z.object({ upstreamVersion: z.string().min(1) });

export const DecisionBodySchema = z
  .object({
    kind: z.enum(['side', 'pin', 'ignore']),
    side: z.enum(['client', 'server', 'both']).optional(),
    reason: ReasonSchema.default(''),
  })
  .refine((d) => d.kind !== 'side' || d.side !== undefined, { message: 'side is required when kind is "side"', path: ['side'] })
  .refine((d) => d.kind === 'side' || d.side === undefined, { message: 'side is only allowed when kind is "side"', path: ['side'] });

export const BlacklistPutSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('adopt-upstream'), server: id, client: id }),
  z.object({ action: z.literal('add'), modId: NewModIdSchema, reason: ReasonSchema.default('') }),
]);
