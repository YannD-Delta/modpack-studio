import { describe, expect, it } from 'vitest';
import { classifySide, effectiveSide, type SideContext, type SideSignal } from '../../src/server/mods/side-classifier.js';

const sig = (origin: SideSignal['origin'], side: SideSignal['side']): SideSignal => ({ origin, side, confidence: 1 });

describe('classifySide', () => {
  it("lets the user's decision beat a base signal, without marking it uncertain", () => {
    expect(classifySide([sig('upstream', 'client'), sig('decision', 'both')])).toEqual({ side: 'both', origin: 'decision', uncertain: false });
  });

  it('lets a base signal beat Modrinth', () => {
    expect(classifySide([sig('modrinth', 'both'), sig('upstream', 'client')])).toMatchObject({ side: 'client', origin: 'upstream' });
  });

  it('marks a Modrinth client_only against a declared both as uncertain', () => {
    expect(classifySide([sig('declared', 'both'), sig('modrinth', 'client')])).toEqual({ side: 'client', origin: 'modrinth', uncertain: true });
  });

  it('is not uncertain when the weaker signals agree', () => {
    expect(classifySide([sig('declared', 'client'), sig('modrinth', 'client')]).uncertain).toBe(false);
  });

  it('returns a null side without any signal', () => {
    expect(classifySide([])).toEqual({ side: null, origin: null, uncertain: false });
  });
});

describe('effectiveSide', () => {
  const ctx = (over: Partial<SideContext> = {}): SideContext => ({ decisions: new Map(), blacklisted: new Set(), declared: new Map(), ...over });

  it('lets the user decision beat the base blacklist and the declared side', () => {
    const c = ctx({ decisions: new Map([['a', 'server' as const]]), blacklisted: new Set(['a']), declared: new Map([['a', 'client' as const]]) });
    expect(effectiveSide('a', c)).toEqual({ side: 'server', origin: 'decision' });
  });

  it('treats a blacklisted mod as client, over its declared side', () => {
    expect(effectiveSide('a', ctx({ blacklisted: new Set(['a']), declared: new Map([['a', 'both' as const]]) }))).toEqual({ side: 'client', origin: 'upstream' });
  });

  it('falls back to the side declared in the jar', () => {
    expect(effectiveSide('a', ctx({ declared: new Map([['a', 'server' as const]]) }))).toEqual({ side: 'server', origin: 'declared' });
  });

  it('is unknown without any usable signal, a declared "unknown" included', () => {
    expect(effectiveSide('a', ctx())).toEqual({ side: 'unknown', origin: null });
    expect(effectiveSide('a', ctx({ declared: new Map([['a', 'unknown' as const]]) }))).toEqual({ side: 'unknown', origin: null });
  });
});
