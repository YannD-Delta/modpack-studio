import { describe, expect, it } from 'vitest';
import { classifySide, type SideSignal } from '../../src/server/mods/side-classifier.js';

const sig = (origin: SideSignal['origin'], side: SideSignal['side']): SideSignal => ({ origin, side, confidence: 1 });

describe('classifySide', () => {
  it("lets Yann's decision beat an ATM signal, without marking it uncertain", () => {
    expect(classifySide([sig('atm', 'client'), sig('decision', 'both')])).toEqual({ side: 'both', origin: 'decision', uncertain: false });
  });

  it('lets an ATM signal beat Modrinth', () => {
    expect(classifySide([sig('modrinth', 'both'), sig('atm', 'client')])).toMatchObject({ side: 'client', origin: 'atm' });
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
