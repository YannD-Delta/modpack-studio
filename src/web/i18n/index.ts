import frAssistant from './fr.assistant.json';
import frConfigs from './fr.configs.json';
import frDecisions from './fr.decisions.json';
import fr from './fr.json';
import frPlan from './fr.plan.json';
import frSettings from './fr.settings.json';

// One JSON file per work stream (core, plan, configs, decisions, settings) so parallel work does not collide.
const messages = { ...fr, ...frPlan, ...frConfigs, ...frDecisions, ...frSettings, ...frAssistant };

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey): string {
  return messages[key];
}

/** Like `t`, filling `{name}` placeholders from `vars`. */
export function tf(key: MessageKey, vars: Record<string, string>): string {
  return messages[key].replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}
