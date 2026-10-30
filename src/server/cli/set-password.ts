import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../api/auth.js';
import { readSettingsObject, writeSettingsPassword } from '../config.js';

// Reads the password from stdin (not from argv, which would end up in the shell history).
const dataDir = process.env.STUDIO_DATA ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

// A broken settings.json is reported before anything is asked, and is never overwritten.
try {
  readSettingsObject(dataDir);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const muted = { on: false };
const output = new Writable({
  write(chunk, _enc, done) {
    if (!muted.on) process.stdout.write(chunk);
    done();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
// Lines are pulled one by one, so piped input (several lines already buffered) is not lost between two questions.
const lines = rl[Symbol.asyncIterator]();

/** On a terminal the typed characters are not echoed; on a pipe (echo pw | npm run set-password) the lines are read as they come. */
async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  muted.on = process.stdin.isTTY === true;
  const next = await lines.next();
  muted.on = false;
  if (process.stdin.isTTY) process.stdout.write(String.fromCharCode(10));
  return next.done ? '' : next.value;
}

const first = await ask('New Studio password: ');
if (first.length < 8) {
  rl.close();
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
const second = await ask('Repeat the password: ');
rl.close();
if (first !== second) {
  console.error('The two passwords differ: nothing was changed.');
  process.exit(1);
}

const file = writeSettingsPassword(dataDir, hashPassword(first));
console.log(`Password saved to ${file}`);
console.log('Restart Studio for the new password to apply: the running server keeps the old password and its sessions until then.');
