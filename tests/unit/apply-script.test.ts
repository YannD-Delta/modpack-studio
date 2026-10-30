import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLY_PS1 } from '../../src/server/plan/apply-script.js';

// apply.ps1 is exercised under every PowerShell found on the machine (7 and Windows PowerShell 5.1);
// the block is skipped only when neither exists.

function findShell(name: string): string | null {
  const r = spawnSync(name, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? name : null;
}
const shells = [findShell('pwsh'), process.platform === 'win32' ? findShell('powershell') : null].filter((s): s is string => !!s);

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const BT = String.fromCharCode(96); // a backtick, kept out of the source text on purpose

interface PackSpec {
  jars?: { file: string; content: string }[];
  files?: { path: string; content: string }[];
  remove?: string[];
  mutate?: (changes: Record<string, unknown>) => void;
}

function makePack(dir: string, spec: PackSpec): string {
  fs.mkdirSync(dir, { recursive: true });
  const jars = spec.jars ?? [];
  const files = spec.files ?? [];
  const changes: Record<string, unknown> = {
    name: 'Test pack',
    base: { label: 'Base 1.0' },
    other: { label: 'Own 1.0' },
    jars: jars.map((j) => ({ file: j.file, sha256: sha(j.content) })),
    files: files.map((f) => ({ path: f.path, sha256: sha(f.content) })),
  };
  spec.mutate?.(changes);
  fs.writeFileSync(path.join(dir, 'changes.json'), JSON.stringify(changes), 'utf8');
  for (const j of jars) {
    fs.mkdirSync(path.join(dir, 'mods-add'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods-add', j.file), j.content);
  }
  for (const f of files) {
    const p = path.join(dir, 'files-add', ...f.path.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
  if (spec.remove) fs.writeFileSync(path.join(dir, 'remove.txt'), spec.remove.join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, 'apply.ps1'), APPLY_PS1, 'ascii');
  return path.join(dir, 'apply.ps1');
}

function makeInstance(dir: string, mods: Record<string, string>, extra: Record<string, string> = {}): string {
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  for (const [n, c] of Object.entries(mods)) fs.writeFileSync(path.join(dir, 'mods', n), c);
  for (const [n, c] of Object.entries(extra)) {
    const p = path.join(dir, ...n.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  return dir;
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push(`${path.relative(dir, p)}/`); walk(p); } else out.push(`${path.relative(dir, p)}:${sha(fs.readFileSync(p))}`);
    }
  };
  walk(dir);
  return out.sort();
}

function run(shell: string, script: string, args: string[]) {
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8', timeout: 120000 });
}
const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

let tmp: string;
const children: ChildProcess[] = [];
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-apply-')); });
afterEach(async () => {
  // wait for the children to be really gone: a running java.exe copy keeps its file (and the folder) locked
  await Promise.all(children.splice(0).map((c) => new Promise<void>((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve();
    c.once('exit', () => resolve());
    try { c.kill(); } catch { resolve(); }
  })));
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp folder, the OS cleans it later */ }
});

describe.skipIf(shells.length === 0)('apply.ps1', () => {
  describe.each(shells)('under %s', (shell) => {
    it('handles special characters in names: dry run changes nothing, apply backs up then copies', () => {
      const oddJar = `a [x] (y) 'q' $d &;,@!#%^+=~{} ${BT}t \u00e9 \u4e2d.jar`;
      const oldJar = `old [x] (y) 'q' $d ${BT}t \u00e9.jar`;
      const cfg = `config/sp ace [x]/\u00e9 $d ${BT}.toml`;
      const script = makePack(path.join(tmp, 'pack'), {
        jars: [{ file: oddJar, content: 'new-jar' }],
        files: [{ path: cfg, content: 'new-cfg' }],
        remove: [oldJar],
      });
      const inst = makeInstance(path.join(tmp, 'inst'), { [oldJar]: 'old-jar' }, { [cfg]: 'old-cfg' });
      const before = snapshot(inst);

      const dry = run(shell, script, ['-InstanceDir', inst]);
      expect(dry.status, out(dry)).toBe(0);
      expect(dry.stdout).toMatch(/dry run/i);
      expect(snapshot(inst)).toEqual(before);

      const real = run(shell, script, ['-InstanceDir', inst, '-Apply']);
      expect(real.status, out(real)).toBe(0);
      const backup = fs.readdirSync(inst).find((n) => n.startsWith('_studio-backup-'))!;
      expect(fs.readFileSync(path.join(inst, backup, 'mods', oldJar), 'utf8')).toBe('old-jar');
      expect(fs.readFileSync(path.join(inst, backup, ...cfg.split('/')), 'utf8')).toBe('old-cfg');
      expect(fs.existsSync(path.join(inst, 'mods', oldJar))).toBe(false);
      expect(fs.readFileSync(path.join(inst, 'mods', oddJar), 'utf8')).toBe('new-jar');
      expect(fs.readFileSync(path.join(inst, ...cfg.split('/')), 'utf8')).toBe('new-cfg');
    }, 120000);

    it('accepts an -InstanceDir with a trailing backslash', () => {
      const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'n-1.0.jar', content: 'n' }] });
      const inst = makeInstance(path.join(tmp, 'inst'), {});
      const r = run(shell, script, ['-InstanceDir', `${inst}\\`]);
      expect(r.status, out(r)).toBe(0);
    }, 120000);

    it('fails cleanly, without a raw exception, when a closing quote was glued to the folder (trailing backslash inside quotes)', () => {
      const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'n-1.0.jar', content: 'n' }] });
      const inst = makeInstance(path.join(tmp, 'inst'), {});
      const before = snapshot(inst);
      const r = run(shell, script, ['-InstanceDir', `${inst}"`, '-Apply']);
      expect(r.status).toBe(1);
      expect(out(r)).toMatch(/instance folder not found/);
      expect(out(r)).toMatch(/trailing backslash/);
      expect(out(r)).not.toMatch(/Test-Path/);
      expect(snapshot(inst)).toEqual(before);
    }, 120000);

    it.each([
      ['a jar name that climbs out', (c: Record<string, unknown>) => { c.jars = [{ file: '../evil.jar', sha256: sha('x') }]; }],
      ['a jar name with a drive', (c: Record<string, unknown>) => { c.jars = [{ file: 'C:evil.jar', sha256: sha('x') }]; }],
      ['a file path with a dot segment', (c: Record<string, unknown>) => { c.files = [{ path: 'config/../x.toml', sha256: sha('x') }]; }],
      ['a file path with a backslash', (c: Record<string, unknown>) => { c.files = [{ path: 'config\\x.toml', sha256: sha('x') }]; }],
      ['an absolute file path', (c: Record<string, unknown>) => { c.files = [{ path: '/x.toml', sha256: sha('x') }]; }],
    ])('refuses a hostile changes.json (%s) with exit 1 and changes nothing', (_name, mutate) => {
      const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'n-1.0.jar', content: 'n' }], mutate });
      const inst = makeInstance(path.join(tmp, 'inst'), { 'o-1.0.jar': 'o' });
      const before = snapshot(inst);
      const r = run(shell, script, ['-InstanceDir', inst, '-Apply']);
      expect(r.status).toBe(1);
      expect(snapshot(inst)).toEqual(before);
    }, 120000);

    it('refuses a remove.txt entry that climbs out of mods, and a sha256 mismatch', () => {
      const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'n-1.0.jar', content: 'n' }], remove: ['..\\x.jar'] });
      const inst = makeInstance(path.join(tmp, 'inst'), { 'o-1.0.jar': 'o' });
      const r1 = run(shell, script, ['-InstanceDir', inst, '-Apply']);
      expect(r1.status).toBe(1);
      expect(out(r1)).toMatch(/unsafe name in remove\.txt/);

      const pack2 = makePack(path.join(tmp, 'pack2'), { jars: [{ file: 'n-1.0.jar', content: 'n' }] });
      fs.appendFileSync(path.join(tmp, 'pack2', 'mods-add', 'n-1.0.jar'), 'tampered');
      const before = snapshot(inst);
      const r2 = run(shell, pack2, ['-InstanceDir', inst, '-Apply']);
      expect(r2.status).toBe(1);
      expect(out(r2)).toMatch(/sha256 mismatch/);
      expect(snapshot(inst)).toEqual(before);
    }, 120000);

    it('exits 1 with a clear message when changes.json is missing', () => {
      const script = makePack(path.join(tmp, 'pack'), {});
      fs.rmSync(path.join(tmp, 'pack', 'changes.json'));
      const inst = makeInstance(path.join(tmp, 'inst'), {});
      const r = run(shell, script, ['-InstanceDir', inst]);
      expect(r.status).toBe(1);
      expect(out(r)).toMatch(/changes\.json not found/);
    }, 120000);

    it('rolls back what this run did when the copy phase fails, and says how to restore', () => {
      const script = makePack(path.join(tmp, 'pack'), {
        jars: [{ file: 'a-2.0.jar', content: 'a2' }],
        files: [{ path: 'config/x.toml', content: 'cfg' }],
        remove: ['a-1.0.jar'],
      });
      // "config" is a file, so creating config/ for the copy fails after the old jar was already moved
      const inst = makeInstance(path.join(tmp, 'inst'), { 'a-1.0.jar': 'a1' }, { config: 'i am a file' });
      const before = snapshot(inst);
      const r = run(shell, script, ['-InstanceDir', inst, '-Apply']);
      expect(r.status, out(r)).toBe(1);
      expect(out(r)).toMatch(/stopped after \d+ move\(s\) and \d+ copy/);
      expect(out(r)).toMatch(/rolled back|restored/i);
      expect(out(r)).toMatch(/_studio-backup-/);
      // the original jar is back and no new jar is left behind; only the (empty-of-originals) backup folder was added
      expect(fs.readFileSync(path.join(inst, 'mods', 'a-1.0.jar'), 'utf8')).toBe('a1');
      expect(fs.existsSync(path.join(inst, 'mods', 'a-2.0.jar'))).toBe(false);
      const backup = fs.readdirSync(inst).find((n) => n.startsWith('_studio-backup-'))!;
      const after = snapshot(inst).filter((e) => !e.startsWith(backup));
      expect(after).toEqual(before);
      expect(fs.existsSync(path.join(inst, backup, 'mods', 'a-1.0.jar'))).toBe(false); // moved back
    }, 120000);

    it('refuses before changing anything when a file to replace is held open by another process', async () => {
      const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'a-2.0.jar', content: 'a2' }], remove: ['a-1.0.jar'] });
      const inst = makeInstance(path.join(tmp, 'inst'), { 'a-1.0.jar': 'a1', 'b-1.0.jar': 'b1' });
      const held = path.join(inst, 'mods', 'a-1.0.jar');
      const holder = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', `$f = [System.IO.File]::Open('${held.replace(/'/g, "''")}', 'Open', 'Read', 'None'); Write-Output locked; Start-Sleep 60`]);
      children.push(holder);
      await new Promise<void>((resolve, reject) => {
        holder.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('locked')) resolve(); });
        holder.on('exit', () => reject(new Error('lock holder exited early')));
        setTimeout(() => reject(new Error('lock holder timeout')), 30000);
      });
      const before = fs.readdirSync(inst).sort();
      const r = run(shell, script, ['-InstanceDir', inst, '-Apply', '-Force']);
      expect(r.status, out(r)).toBe(1);
      expect(out(r)).toMatch(/in use/i);
      expect(out(r)).toMatch(/nothing was changed/i);
      expect(fs.readdirSync(inst).sort()).toEqual(before); // no backup folder was even created
      expect(fs.existsSync(path.join(inst, 'mods', 'a-2.0.jar'))).toBe(false);
    }, 120000);

    describe.skipIf(process.platform !== 'win32')('running-game guard', () => {
      // a renamed copy of cmd.exe stands in for java.exe; its command line carries the given path
      function startFakeJava(arg: string): ChildProcess {
        const dir = path.join(tmp, `fake-${children.length}`);
        fs.mkdirSync(dir, { recursive: true });
        const exe = path.join(dir, 'java.exe');
        fs.copyFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', exe);
        const child = spawn(exe, ['/c', 'ping', '-n', '90', '127.0.0.1', '>nul', '&', 'rem', arg], { stdio: 'ignore', windowsHide: true });
        children.push(child);
        return child;
      }
      const setup = () => {
        const script = makePack(path.join(tmp, 'pack'), { jars: [{ file: 'a-2.0.jar', content: 'a2' }], remove: ['a-1.0.jar'] });
        const inst = makeInstance(path.join(tmp, 'Inst Pack (1)'), { 'a-1.0.jar': 'a1' });
        return { script, inst };
      };

      it('warns on a dry run, refuses -Apply, and lets -Force through', async () => {
        const { script, inst } = setup();
        startFakeJava(inst);
        await new Promise((r) => setTimeout(r, 1500));
        const before = snapshot(inst);
        const dry = run(shell, script, ['-InstanceDir', inst]);
        expect(dry.status, out(dry)).toBe(0);
        expect(out(dry)).toMatch(/WARNING/);
        const blocked = run(shell, script, ['-InstanceDir', inst, '-Apply']);
        expect(blocked.status, out(blocked)).toBe(1);
        expect(out(blocked)).toMatch(/Close the game first/);
        expect(snapshot(inst)).toEqual(before);
        const forced = run(shell, script, ['-InstanceDir', inst, '-Apply', '-Force']);
        expect(forced.status, out(forced)).toBe(0);
        expect(fs.existsSync(path.join(inst, 'mods', 'a-2.0.jar'))).toBe(true);
      }, 180000);

      it.each([
        ['a sibling folder sharing a prefix', (i: string) => `${i}-two\\mods`, false],
        ['a sibling folder with a longer name', (i: string) => `${i}extra`, false],
        ['a process started from inside the folder', (i: string) => `${i}\\libraries\\x.jar`, true],
        ['forward slashes', (i: string) => i.replace(/\\/g, '/'), true],
        ['forward slashes inside the folder', (i: string) => `${i.replace(/\\/g, '/')}/mods`, true],
        ['a trailing separator', (i: string) => `${i}\\`, true],
        ['a different letter case', (i: string) => i.toUpperCase(), true],
        ['the path in double quotes', (i: string) => `"${i}"`, true],
      ])('detection is exact on the instance path: %s', async (_name, build, blocks) => {
        const { script, inst } = setup();
        startFakeJava(build(inst));
        await new Promise((r) => setTimeout(r, 1500));
        const r = run(shell, script, ['-InstanceDir', inst, '-Apply']);
        if (blocks) {
          expect(r.status, out(r)).toBe(1);
          expect(out(r)).toMatch(/Close the game first/);
          expect(fs.existsSync(path.join(inst, 'mods', 'a-2.0.jar'))).toBe(false);
        } else {
          expect(r.status, out(r)).toBe(0);
          expect(fs.existsSync(path.join(inst, 'mods', 'a-2.0.jar'))).toBe(true);
        }
      }, 180000);
    });
  });
});
