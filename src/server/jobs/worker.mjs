// Plain JS on purpose: piscina workers load this file directly, without a TypeScript loader.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

const tasks = {
  async 'sha256-file'({ path }) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(path);
    stream.on('data', (c) => {
      size += c.length;
    });
    await pipeline(stream, hash);
    return { sha256: hash.digest('hex'), size };
  },
  async echo(payload) {
    return payload;
  },
};

export default async function run({ task, payload }) {
  const fn = tasks[task];
  if (!fn) throw new Error(`unknown task: ${task}`);
  return fn(payload);
}
