import { z } from 'zod';

const id = z.coerce.number().int().positive();

export const DiffQuerySchema = z.object({ base: id, other: id });
export const AtmSidesQuerySchema = z.object({ server: id, client: id });
export const AnomaliesQuerySchema = z.object({ atmClient: id, lmp: id });
export const LoaderCheckQuerySchema = z.object({ profiles: z.string().regex(/^\d+(,\d+)*$/) });
export const BlacklistQuerySchema = z.object({ atmVersion: z.string().min(1) });

export const DecisionBodySchema = z.object({
  kind: z.enum(['side', 'pin', 'ignore']),
  side: z.enum(['client', 'server', 'both']).optional(),
  reason: z.string().default(''),
});

export const BlacklistPutSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('adopt-atm'), server: id, client: id }),
  z.object({ action: z.literal('add'), modId: z.string().min(1), reason: z.string().default('') }),
]);
