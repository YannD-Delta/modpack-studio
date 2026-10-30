export type Side = 'client' | 'server' | 'both';
export type SideOrigin = 'decision' | 'upstream' | 'modrinth' | 'declared';
export type SideSignal = { origin: SideOrigin; side: Side; confidence: number };
export type SideVerdict = { side: Side | null; origin: SideOrigin | null; uncertain: boolean };

// Highest priority first. Boot-test proof, @Mod(dist), CurseForge tags, the community list and the bytecode heuristic come in later phases.
const PRIORITY: SideOrigin[] = ['decision', 'upstream', 'modrinth', 'declared'];
// the user's decision and the base pack's own client/server split are authoritative: a disagreeing weaker signal does not make them uncertain.
const AUTHORITATIVE = new Set<SideOrigin>(['decision', 'upstream']);

export function classifySide(signals: SideSignal[]): SideVerdict {
  const ordered = [...signals].sort((a, b) => PRIORITY.indexOf(a.origin) - PRIORITY.indexOf(b.origin));
  const winner = ordered[0];
  if (!winner) return { side: null, origin: null, uncertain: false };
  const disagreement = ordered.some((s) => s.side !== winner.side);
  return { side: winner.side, origin: winner.origin, uncertain: !AUTHORITATIVE.has(winner.origin) && disagreement };
}

/** What the server pack needs to settle a mod's side. All keys are mod ids. */
export type SideContext = {
  /** The user's side decisions. */
  decisions: ReadonlyMap<string, Side>;
  /** The server blacklist (base-derived and the user's rows): such a mod is client only. */
  blacklisted: ReadonlySet<string>;
  /** Side declared in the jar metadata (jar_mod.declared_side). */
  declared: ReadonlyMap<string, Side | 'unknown'>;
};
export type EffectiveSide = { side: Side | 'unknown'; origin: SideOrigin | null };

/** Priority: the user's decision, then the base's derived split (blacklisted = client), then the side the jar declares, else unknown. */
export function effectiveSide(modId: string, ctx: SideContext): EffectiveSide {
  const signals: SideSignal[] = [];
  const decision = ctx.decisions.get(modId);
  if (decision) signals.push({ origin: 'decision', side: decision, confidence: 1 });
  if (ctx.blacklisted.has(modId)) signals.push({ origin: 'upstream', side: 'client', confidence: 1 });
  const declared = ctx.declared.get(modId);
  if (declared && declared !== 'unknown') signals.push({ origin: 'declared', side: declared, confidence: 0.5 });
  const v = classifySide(signals);
  return v.side ? { side: v.side, origin: v.origin } : { side: 'unknown', origin: null };
}
