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

export const settingsPath = (dataDir: string): string => path.join(dataDir, 'settings.json');

/** Reads settings.json as a plain object: missing file is empty; a broken one throws an Error that names the file (never defaults silently). */
export function readSettingsObject(dataDir: string): Record<string, unknown> {
  const file = settingsPath(dataDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}): fix or delete it, then start again.`, { cause: err });
  }
}

/** Reads `<dataDir>/settings.json` (zod-validated); a missing file gives the defaults. */
export function loadConfig(dataDir: string): Config {
  const parsed = ConfigSchema.safeParse(readSettingsObject(dataDir));
  if (!parsed.success) throw new Error(`${settingsPath(dataDir)} has invalid values: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** Writes the password hash into settings.json atomically (temp file + rename), keeping every other setting. */
export function writeSettingsPassword(dataDir: string, passwordHash: string): string {
  const file = settingsPath(dataDir);
  const next = { ...readSettingsObject(dataDir), passwordHash };
  const tmp = `${file}.${process.pid}.part`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}
