import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { hashPassword } from '../api/auth.js';

// Reads the password from stdin (not from argv, which would end up in the shell history).
const dataDir = process.env.STUDIO_DATA ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('New Studio password: ');
rl.close();
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const file = path.join(dataDir, 'settings.json');
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
settings.passwordHash = hashPassword(password);
fs.writeFileSync(file, JSON.stringify(settings, null, 2));
console.log(`Password saved to ${file}`);
