import type { Db } from '../db/open.js';
import type { LoaderInfo } from '../loader/detect-loader.js';
import { getPins } from '../mods/blacklist-service.js';
import { getSources, type CfSource } from '../mods/curseforge-sources.js';
import { diffModSets, type ModEntry } from '../mods/diff.js';
import { loadModSet } from '../mods/modset-store.js';
import type { Profile } from '../profiles/profile-service.js';
import type { PackNames } from '../settings/packs.js';
import type { ClientLogsResult } from '../testbench/client-logs.js';
import type { RunDetail } from '../testbench/runs.js';

export const PAIR_ACTIONS = ['review-updates', 'review-added', 'review-missing', 'migrate-old-pack'] as const;
export const ACTIONS = [...PAIR_ACTIONS, 'analyze-test-run'] as const;
export type PairActionId = (typeof PAIR_ACTIONS)[number];
export type ActionId = (typeof ACTIONS)[number];
export type PromptMode = 'chat' | 'api';

export const ACTION_INFO: Record<ActionId, { label: string; tip: string }> = {
  'review-updates': {
    label: 'Mises à jour proposées',
    tip: 'Claude dit pour chaque mod pas à jour si la mise à jour vaut le coup, ce qu’il faut surveiller, et dans quel ordre les faire.',
  },
  'review-added': {
    label: 'Mods ajoutés',
    tip: 'Claude dit si les mods que tu as ajoutés sont vraiment utiles, s’ils font doublon avec ceux de {upstream} ou s’ils risquent de poser problème.',
  },
  'review-missing': {
    label: 'Mods manquants',
    tip: 'Claude regarde les mods de {upstream} absents de ton pack : retrait volontaire probable ou oubli, et si un équivalent existe déjà.',
  },
  'analyze-test-run': {
    label: 'Analyser ce test',
    tip: 'Claude lit le journal et le rapport de plantage du test : ce qui bloque, ce qui vient de {upstream} et se retrouve chez tout le monde, ce qui est sans importance, et la correction à essayer.',
  },
  'migrate-old-pack': {
    label: 'Ancien pack contre {upstream}',
    tip: 'Claude compare ton ancien pack avec {upstream} : mods manquants, équivalents déjà dans {upstream}, disponibilité sur le mod loader et la bonne version de Minecraft, priorités.',
  },
};

/** Fills the `{upstream}` and `{own}` placeholders with the pack names chosen in Settings. */
export const fillNames = (text: string, names: PackNames): string => text.replaceAll('{upstream}', names.upstream).replaceAll('{own}', names.own);

export type BuiltPrompt = { action: ActionId | 'analyze-client-run'; title: string; prompt: string; rows: number; shown: number };

const label = (p: Profile) => `${p.pack} ${p.version} · ${p.side} · ${p.state}`;
const loaderText = (l: LoaderInfo | null) => (l ? `${l.loader} ${l.loaderVersion}, Minecraft ${l.mcVersion ?? 'inconnu'}` : 'loader non détecté');
/** The loader of the reference pack as detected (never assumed); "mod loader" when it is unknown. */
const loaderName = (l: LoaderInfo | null) => l?.loader ?? 'mod loader';
const link = (s: CfSource | undefined) => (s ? s.url : 'lien inconnu');

type Row = { modId: string; text: string };

function intro(mode: PromptMode): string {  // placeholders are filled when the whole prompt is assembled
  const web =
    mode === 'chat'
      ? 'Tu as accès à la recherche web : ouvre les liens CurseForge fournis pour lire la page, les changements récents et la compatibilité avant de conclure.'
      : 'Tu n’as pas accès à internet dans cet échange : base-toi sur tes connaissances, dis clairement ce dont tu n’es pas sûr, et indique ce que je dois vérifier sur la page CurseForge (les liens sont donnés).';
  return [
    'Tu m’aides à maintenir {own}, mon modpack Minecraft personnel construit sur {upstream}.',
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
 * `base` is the reference (the followed pack), `other` the compared one (the player's pack, or the old pack for `migrate-old-pack`).
 * The same text serves both uses: sent through the API, or copied into claude.ai.
 */
export function buildPrompt(
  db: Db,
  args: { action: PairActionId; base: Profile; other: Profile; baseLoader: LoaderInfo | null; otherLoader: LoaderInfo | null; mode: PromptMode; names: PackNames; maxRows?: number },
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
        'Voici les mods présents seulement dans le comparé (ceux que j’ai ajoutés à {upstream}).',
        'Pour chacun : à quoi sert-il, est-il vraiment utile, fait-il doublon avec un mod de {upstream}, risque-t-il de poser un problème (performances, compatibilité, côté client ou serveur) ?',
        'Verdict par mod : garder, à vérifier ou retirer, puis un résumé des mods les moins utiles.',
      ].join('\n');
      break;
    }
    case 'review-missing': {
      rows = diff.removed.map((e) => ({ modId: e.modId, text: `- ${e.modId} ${e.version} | page : ${link(srcOf(baseSrc, e))}` }));
      task = [
        'Voici les mods présents dans la référence ({upstream}) mais absents du comparé.',
        'Pour chacun : retrait probablement volontaire ou oubli ? Un autre mod du comparé joue-t-il le même rôle ? Son absence peut-elle casser quelque chose (dépendance, quêtes, recettes) ?',
        'Verdict par mod : remettre, laisser retiré ou à vérifier.',
      ].join('\n');
      break;
    }
    case 'migrate-old-pack': {
      rows = diff.added.map((e) => ({ modId: e.modId, text: `- ${e.modId} ${e.version} | page : ${link(srcOf(otherSrc, e))}` }));
      const shared = diff.unchanged + diff.updated.length + diff.rebuilt.length;
      task = [
        `Le comparé est mon ancien pack. Il a ${shared} mods en commun avec {upstream} (par identifiant de mod) et ${diff.added.length} mods que {upstream} n’a pas : ce sont les candidats à reprendre dans mon nouveau {own}.`,
        `Compare aussi les loaders : l’ancien pack tourne sur ${loaderText(args.otherLoader)}, le nouveau sur ${loaderText(args.baseLoader)}.`,
        `Pour chaque mod de la liste : (1) existe-t-il une version ${loaderName(args.baseLoader)} pour la version de Minecraft de la référence ? (2) un mod de {upstream} fait-il déjà la même chose (équivalent) ? (3) vaut-il la peine d’être repris ?`,
        `Réponds avec un tableau (Mod, Disponible en ${loaderName(args.baseLoader)}, Équivalent dans {upstream}, Verdict : reprendre, équivalent suffisant, abandonner, à vérifier), puis les priorités : les 10 mods à reprendre d’abord.`,
      ].join('\n');
      break;
    }
  }

  const { shown, note } = cap(rows, maxRows);
  const list = shown.length ? shown.map((r) => r.text).join('\n') : '(aucun mod dans cette liste)';
  const prompt = fillNames([intro(mode), '', header, '', task, '', 'Liste :', list + note].join('\n'), args.names);
  return { action, title: fillNames(ACTION_INFO[action].label, args.names), prompt, rows: rows.length, shown: shown.length };
}

const TAIL_LINES = 150;

/** Prompt that asks Claude to read one server test: summary, first errors, crash report head and the end of the console log. */
export function buildTestRunPrompt(args: { run: RunDetail; logTail: string[]; crashHead: string | null; mode: PromptMode; names: PackNames }): BuiltPrompt {
  const { run, mode } = args;
  const r = run.result;
  const facts = [
    `Test : ${run.meta.label} (serveur copié dans un dossier temporaire, port ${run.meta.port}, mémoire ${run.meta.memoryMb} Mo, mode hors ligne).`,
    `Résultat : ${run.status}${run.message ? ` (${run.message})` : ''}.`,
    r
      ? `Démarrage : ${r.bootSeconds === null ? 'jamais arrivé à « Done »' : `${r.bootSeconds} s`} · ${r.modJars} jars de mods · ${r.summary.errorLines} lignes d\u2019erreur · ${r.summary.warnLines} avertissements · ${r.crashReports.length} rapport(s) de plantage.`
      : 'Pas de résultat final.',
  ];
  const errors = r?.summary.firstErrors.length ? r.summary.firstErrors.map((e) => `- ${e}`).join('\n') : '(aucune)';
  const tail = args.logTail.slice(-TAIL_LINES).join('\n') || '(journal vide)';
  const task = [
    'Analyse ce test de démarrage d\u2019un serveur Minecraft modé.',
    'Dis d\u2019abord s\u2019il est sain. Puis sépare : ce qui bloque, ce qui est hérité de {upstream} (présent chez tout le monde, à ignorer), et ce qui est sans importance.',
    'Pour chaque problème bloquant : la cause probable (mod, version, dépendance, config) et la correction à essayer (mettre à jour, épingler, retirer, changer une valeur).',
    'Termine par les trois actions à faire en premier.',
  ].join('\n');
  const prompt = fillNames([
    intro(mode),
    '',
    ...facts,
    '',
    task,
    '',
    'Premières erreurs distinctes :',
    errors,
    '',
    args.crashHead ? `Début du rapport de plantage :\n${args.crashHead}\n` : '',
    `Fin du journal (${Math.min(TAIL_LINES, args.logTail.length)} dernières lignes) :`,
    tail,
  ].join('\n'), args.names);
  return { action: 'analyze-test-run', title: fillNames(ACTION_INFO['analyze-test-run'].label, args.names), prompt, rows: r?.summary.errorLines ?? 0, shown: r?.summary.firstErrors.length ?? 0 };
}

/** Second analysis action, built from a client instance run by hand. It is not in ACTIONS: it takes a profile, not a server test or a pair. */
export const CLIENT_RUN_ACTION = 'analyze-client-run' as const;
export const CLIENT_RUN_INFO = {
  label: 'Analyser ce lancement du client',
  tip: 'Claude lit le journal et le rapport de plantage du client que tu as lancé à la main : ce qui bloque, ce qui vient de {upstream} et se retrouve chez tout le monde, ce qui est sans importance, et la correction à essayer.',
};

/** Prompt that asks Claude to read the logs of a client run by hand: counts, first errors, loading markers, crash headlines and mod differences. */
export function buildClientRunPrompt(args: { logs: ClientLogsResult; mode: PromptMode; names: PackNames }): BuiltPrompt {
  const { logs, mode } = args;
  const l = logs.log;
  const found = l.markers.filter((m) => m.line !== null).length;
  const facts = [
    `Client : ${logs.profile.label}, lancé à la main (les journaux ci-dessous viennent de logs/latest.log et de crash-reports/).`,
    l.present
      ? `Journal : ${l.lines} lignes lues${l.truncated ? ' (fin du fichier seulement)' : ''} · ${l.errorLines} lignes d’erreur · ${l.warnLines} avertissements.`
      : 'Journal : logs/latest.log est absent.',
    `Repères de fin de chargement trouvés : ${found} sur ${l.markers.length}${l.reachedAllMarkers ? ' (chargement terminé)' : ' (le jeu n’est peut-être pas allé jusqu’au menu)'}. Un client n’a pas de ligne « Done » comme un serveur : ces repères sont des motifs de lignes, à relativiser.`,
    ...l.markers.map((m) => `- ${m.pattern} : ${m.line === null ? 'absent' : `ligne ${m.line}`}`),
    `Mods : ${logs.mods.count} jars dans mods/.`,
  ];
  if (logs.mods.imported && logs.mods.onlyInInstance.length) facts.push(`Dans le dossier mais pas dans l’import : ${logs.mods.onlyInInstance.join(', ')}.`);
  if (logs.mods.imported && logs.mods.onlyInImport.length) facts.push(`Dans l’import mais plus dans le dossier : ${logs.mods.onlyInImport.join(', ')}.`);
  const errors = l.firstErrors.length ? l.firstErrors.map((e) => `- ${e}`).join('\n') : '(aucune)';
  const crashes = logs.crashReports.length
    ? logs.crashReports.map((c) => `${c.name} (${c.modified}) : ${c.headline ?? 'titre inconnu'}${c.head ? `\n${c.head}` : ''}`).join('\n\n')
    : '(aucun rapport de plantage)';
  const task = [
    'Analyse le lancement d’un client Minecraft modé.',
    'Dis d’abord s’il est sain. Puis sépare : ce qui bloque, ce qui est hérité de {upstream} (présent chez tout le monde, à ignorer), et ce qui est sans importance.',
    'Pour chaque problème bloquant : la cause probable (mod, version, dépendance, config, mixin) et la correction à essayer (mettre à jour, épingler, retirer, changer une valeur).',
    'Termine par les trois actions à faire en premier.',
  ].join('\n');
  const prompt = fillNames([intro(mode), '', ...facts, '', task, '', 'Premières erreurs distinctes :', errors, '', 'Rapports de plantage :', crashes].join('\n'), args.names);
  return { action: CLIENT_RUN_ACTION, title: fillNames(CLIENT_RUN_INFO.label, args.names), prompt, rows: l.errorLines, shown: l.firstErrors.length };
}
