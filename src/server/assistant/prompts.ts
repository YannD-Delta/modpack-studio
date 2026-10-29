import type { Db } from '../db/open.js';
import type { LoaderInfo } from '../loader/detect-loader.js';
import { getPins } from '../mods/blacklist-service.js';
import { getSources, type CfSource } from '../mods/curseforge-sources.js';
import { diffModSets, type ModEntry } from '../mods/diff.js';
import { loadModSet } from '../mods/modset-store.js';
import type { Profile } from '../profiles/profile-service.js';

export const ACTIONS = ['review-updates', 'review-added', 'review-missing', 'migrate-old-pack'] as const;
export type ActionId = (typeof ACTIONS)[number];
export type PromptMode = 'chat' | 'api';

export const ACTION_INFO: Record<ActionId, { label: string; tip: string }> = {
  'review-updates': {
    label: 'Mises à jour proposées',
    tip: 'Claude dit pour chaque mod pas à jour si la mise à jour vaut le coup, ce qu’il faut surveiller, et dans quel ordre les faire.',
  },
  'review-added': {
    label: 'Mods ajoutés',
    tip: 'Claude dit si les mods que tu as ajoutés sont vraiment utiles, s’ils font doublon avec ceux d’ATM10 ou s’ils risquent de poser problème.',
  },
  'review-missing': {
    label: 'Mods manquants',
    tip: 'Claude regarde les mods d’ATM10 absents de ton pack : retrait volontaire probable ou oubli, et si un équivalent existe déjà.',
  },
  'migrate-old-pack': {
    label: 'Ancien pack contre ATM10',
    tip: 'Claude compare ton ancien pack avec ATM10 : mods manquants, équivalents déjà dans ATM10, disponibilité NeoForge sur la bonne version de Minecraft, priorités.',
  },
};

export type BuiltPrompt = { action: ActionId; title: string; prompt: string; rows: number; shown: number };

const label = (p: Profile) => `${p.pack} ${p.version} · ${p.side} · ${p.state}`;
const loaderText = (l: LoaderInfo | null) => (l ? `${l.loader} ${l.loaderVersion}, Minecraft ${l.mcVersion ?? 'inconnu'}` : 'loader non détecté');
const link = (s: CfSource | undefined) => (s ? s.url : 'lien inconnu');

type Row = { modId: string; text: string };

function intro(mode: PromptMode): string {
  const web =
    mode === 'chat'
      ? 'Tu as accès à la recherche web : ouvre les liens CurseForge fournis pour lire la page, les changements récents et la compatibilité avant de conclure.'
      : 'Tu n’as pas accès à internet dans cet échange : base-toi sur tes connaissances, dis clairement ce dont tu n’es pas sûr, et indique ce que je dois vérifier sur la page CurseForge (les liens sont donnés).';
  return [
    'Tu m’aides à maintenir LMP, mon modpack Minecraft personnel construit sur ATM10 (All the Mods 10, NeoForge).',
    web,
    'Réponds en français, de façon concrète.',
  ].join('\n');
}

function cap(rows: Row[], maxRows: number): { shown: Row[]; note: string } {
  if (rows.length <= maxRows) return { shown: rows, note: '' };
  return { shown: rows.slice(0, maxRows), note: `\n(Liste tronquée : ${maxRows} mods affichés sur ${rows.length}.)` };
}

/**
 * Builds the ready-made prompt of one action from the comparison of two imported profiles.
 * `base` is the reference (ATM10), `other` the compared one (LMP, or the old pack for `migrate-old-pack`).
 * The same text serves both uses: sent through the API, or copied into claude.ai.
 */
export function buildPrompt(
  db: Db,
  args: { action: ActionId; base: Profile; other: Profile; baseLoader: LoaderInfo | null; otherLoader: LoaderInfo | null; mode: PromptMode; maxRows?: number },
): BuiltPrompt {
  const { action, base, other, mode } = args;
  const maxRows = args.maxRows ?? 400;
  const baseSet = loadModSet(db, base.id);
  const otherSet = loadModSet(db, other.id);
  const baseSrc = getSources(db, base.id);
  const otherSrc = getSources(db, other.id);
  const diff = diffModSets(baseSet, otherSet, { pins: getPins(db) });
  const srcOf = (srcs: Map<string, CfSource>, e: ModEntry) => srcs.get(e.file);

  const header = [
    `Référence : ${label(base)} (${loaderText(args.baseLoader)}), ${baseSet.size} mods.`,
    `Comparé : ${label(other)} (${loaderText(args.otherLoader)}), ${otherSet.size} mods.`,
  ].join('\n');

  let rows: Row[] = [];
  let task = '';
  switch (action) {
    case 'review-updates': {
      rows = diff.updated
        .filter((u) => u.direction !== 'newer')
        .map((u) => ({
          modId: u.modId,
          text: `- ${u.modId} : ${u.to.version} chez le comparé → ${u.from.version} dans la référence | page : ${link(srcOf(baseSrc, u.from))} | page chez le comparé : ${link(srcOf(otherSrc, u.to))}`,
        }));
      task = [
        'Voici les mods du comparé qui ne sont pas à la version de la référence.',
        'Pour chacun : la mise à jour vaut-elle le coup (correctif important, nouveauté utile, ou simple changement mineur) ? Y a-t-il un risque (changement cassant, config à revoir, dépendance) ?',
        'Termine par un ordre conseillé pour les faire, et la liste des mises à jour à faire en premier.',
      ].join('\n');
      break;
    }
    case 'review-added': {
      rows = diff.added.map((e) => ({ modId: e.modId, text: `- ${e.modId} ${e.version} | page : ${link(srcOf(otherSrc, e))}` }));
      task = [
        'Voici les mods présents seulement dans le comparé (ceux que j’ai ajoutés à ATM10).',
        'Pour chacun : à quoi sert-il, est-il vraiment utile, fait-il doublon avec un mod d’ATM10, risque-t-il de poser un problème (performances, compatibilité, côté client ou serveur) ?',
        'Verdict par mod : garder, à vérifier ou retirer, puis un résumé des mods les moins utiles.',
      ].join('\n');
      break;
    }
    case 'review-missing': {
      rows = diff.removed.map((e) => ({ modId: e.modId, text: `- ${e.modId} ${e.version} | page : ${link(srcOf(baseSrc, e))}` }));
      task = [
        'Voici les mods présents dans la référence (ATM10) mais absents du comparé.',
        'Pour chacun : retrait probablement volontaire ou oubli ? Un autre mod du comparé joue-t-il le même rôle ? Son absence peut-elle casser quelque chose (dépendance, quêtes, recettes) ?',
        'Verdict par mod : remettre, laisser retiré ou à vérifier.',
      ].join('\n');
      break;
    }
    case 'migrate-old-pack': {
      rows = diff.added.map((e) => ({ modId: e.modId, text: `- ${e.modId} ${e.version} | page : ${link(srcOf(otherSrc, e))}` }));
      const shared = diff.unchanged + diff.updated.length + diff.rebuilt.length;
      task = [
        `Le comparé est mon ancien pack. Il a ${shared} mods en commun avec ATM10 (par identifiant de mod) et ${diff.added.length} mods qu’ATM10 n’a pas : ce sont les candidats à reprendre dans mon nouveau LMP.`,
        `Compare aussi les loaders : l’ancien pack tourne sur ${loaderText(args.otherLoader)}, le nouveau sur ${loaderText(args.baseLoader)}.`,
        'Pour chaque mod de la liste : (1) existe-t-il une version NeoForge pour la version de Minecraft de la référence ? (2) un mod d’ATM10 fait-il déjà la même chose (équivalent) ? (3) vaut-il la peine d’être repris ?',
        'Réponds avec un tableau (Mod, Disponible en NeoForge, Équivalent dans ATM10, Verdict : reprendre, équivalent suffisant, abandonner, à vérifier), puis les priorités : les 10 mods à reprendre d’abord.',
      ].join('\n');
      break;
    }
  }

  const { shown, note } = cap(rows, maxRows);
  const list = shown.length ? shown.map((r) => r.text).join('\n') : '(aucun mod dans cette liste)';
  const prompt = [intro(mode), '', header, '', task, '', 'Liste :', list + note].join('\n');
  return { action, title: ACTION_INFO[action].label, prompt, rows: rows.length, shown: shown.length };
}
