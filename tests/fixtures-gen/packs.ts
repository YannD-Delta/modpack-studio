import fs from 'node:fs';
import path from 'node:path';
import { makeJar, makeZip, type JarSpec } from './jar.js';

export async function writeAtmPack(
  dir: string,
  v: { atm: string; neoforge: string; mc: string; serverMods: JarSpec[]; clientMods: JarSpec[]; wrapperDir?: string },
): Promise<{ serverZip: string; clientDir: string }> {
  fs.mkdirSync(dir, { recursive: true });

  const entries: Record<string, Buffer | string> = {
    'startserver.bat': `@echo off\r\nset NEOFORGE_VERSION=${v.neoforge}\r\nset MINECRAFT_VERSION=${v.mc}\r\n`,
    [`neoforge-${v.neoforge}-installer.jar`]: Buffer.from('installer'),
    'user_jvm_args.txt': '-Xms4G -Xmx8G\n',
    'config/atm.toml': 'welcome = true\n',
  };
  for (const spec of v.serverMods) entries[`mods/${spec.fileName}`] = await makeJar(spec);
  const serverZip = path.join(dir, `Base-${v.atm}-server.zip`);
  fs.writeFileSync(serverZip, await makeZip(entries, { wrapperDir: v.wrapperDir }));

  const clientDir = path.join(dir, `client-${v.atm}`);
  fs.mkdirSync(path.join(clientDir, 'mods'), { recursive: true });
  for (const spec of v.clientMods) fs.writeFileSync(path.join(clientDir, 'mods', spec.fileName), await makeJar(spec));
  fs.writeFileSync(
    path.join(clientDir, 'minecraftinstance.json'),
    JSON.stringify({
      gameVersion: v.mc,
      baseModLoader: { name: `neoforge-${v.neoforge}`, forgeVersion: v.neoforge, minecraftVersion: v.mc, type: 6 },
    }),
  );
  return { serverZip, clientDir };
}
