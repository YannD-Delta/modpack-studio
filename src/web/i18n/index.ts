import fr from './fr.json';

export type MessageKey = keyof typeof fr;

export function t(key: MessageKey): string {
  return fr[key];
}
