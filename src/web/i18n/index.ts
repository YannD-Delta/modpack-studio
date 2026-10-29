import fr from './fr.json';

export type MessageKey = keyof typeof fr;

export function t(key: MessageKey): string {
  return fr[key];
}

/** Like `t`, filling `{name}` placeholders from `vars`. */
export function tf(key: MessageKey, vars: Record<string, string>): string {
  return fr[key].replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
}
