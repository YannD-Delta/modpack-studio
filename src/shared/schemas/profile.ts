import { z } from 'zod';

export const NewProfileSchema = z.object({
  pack: z.string().min(1).max(40),
  version: z.string().min(1),
  side: z.enum(['client', 'server']),
  state: z.enum(['clean', 'launched', 'run']),
  locationKind: z.enum(['zip', 'folder', 'smb', 'agent']),
  location: z.string().min(1),
});

export const ModSetSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zip'), path: z.string().min(1) }),
  z.object({ kind: z.literal('folder'), path: z.string().min(1) }),
]);

export const ImportBodySchema = z.object({ source: ModSetSourceSchema });
