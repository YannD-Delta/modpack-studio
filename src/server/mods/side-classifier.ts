export type Side = 'client' | 'server' | 'both';
export type SideOrigin = 'decision' | 'atm' | 'modrinth' | 'declared';
export type SideSignal = { origin: SideOrigin; side: Side; confidence: number };
export type SideVerdict = { side: Side | null; origin: SideOrigin | null; uncertain: boolean };

// Highest priority first. Boot-test proof, @Mod(dist), CurseForge tags, the community list and the bytecode heuristic come in later phases.
const PRIORITY: SideOrigin[] = ['decision', 'atm', 'modrinth', 'declared'];
// the user's decision and ATM's own client/server split are authoritative: a disagreeing weaker signal does not make them uncertain.
const AUTHORITATIVE = new Set<SideOrigin>(['decision', 'atm']);

export function classifySide(signals: SideSignal[]): SideVerdict {
  const ordered = [...signals].sort((a, b) => PRIORITY.indexOf(a.origin) - PRIORITY.indexOf(b.origin));
  const winner = ordered[0];
  if (!winner) return { side: null, origin: null, uncertain: false };
  const disagreement = ordered.some((s) => s.side !== winner.side);
  return { side: winner.side, origin: winner.origin, uncertain: !AUTHORITATIVE.has(winner.origin) && disagreement };
}
