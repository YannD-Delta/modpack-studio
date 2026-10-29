import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  bindHost: z.string().default('127.0.0.1'),
  lanIp: z.string().optional(),
  port: z.number().int().min(0).max(65535).default(8480),
  passwordHash: z.string().optional(),
  allowedHosts: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Reads `<dataDir>/settings.json` (zod-validated); a missing file gives the defaults. */
export function loadConfig(dataDir: string): Config {
  const file = path.join(dataDir, 'settings.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return ConfigSchema.parse(raw);
}
