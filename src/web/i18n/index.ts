import frAssistant from './fr.assistant.json';
import frConfigs from './fr.configs.json';
import frDecisions from './fr.decisions.json';
import fr from './fr.json';
import frPlan from './fr.plan.json';
import frProjects from './fr.projects.json';
import frTestbench from './fr.testbench.json';
import frSettings from './fr.settings.json';

// One JSON file per work stream (core, plan, configs, decisions, settings) so parallel work does not collide.
const messages = { ...fr, ...frPlan, ...frConfigs, ...frDecisions, ...frSettings, ...frAssistant, ...frTestbench, ...frProjects };

export type MessageKey = keyof typeof messages;

/** The two pack names chosen in Settings: the followed pack (Base by default) and the player's own (Own by default). */
export type PackNames = { upstream: string; own: string };
let packNames: PackNames = { upstream: 'Base', own: 'Own' };
export const getPackNames = (): PackNames => packNames;
export const setPackNames = (n: PackNames): void => {
  packNames = n;
};
const fill = (text: string) => text.replaceAll('{upstream}', packNames.upstream).replaceAll('{own}', packNames.own);

/** Looks up a key that is only known at run time (a limit registered by the server); falls back to the given text. */
export function tOr(key: string, fallback: string): string {
  const text = (messages as Record<string, string>)[key];
  return text === undefined ? fallback : fill(text);
}

/** `tOr` with `{name}` placeholders filled from `vars`. */
export function tfOr(key: string, vars: Record<string, string>, fallback: string): string {
  return tOr(key, fallback).replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}

export function t(key: MessageKey): string {
  return fill(messages[key]);
}

/** Like `t`, filling `{name}` placeholders from `vars`. */
export function tf(key: MessageKey, vars: Record<string, string>): string {
  return fill(messages[key]).replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}
