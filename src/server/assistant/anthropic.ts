import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../settings/secrets-store.js';

/** The only host the key and the prompts are ever sent to. ANTHROPIC_BASE_URL from the environment is deliberately ignored. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/** Client-side timeout of one (non-streaming) answer. */
export const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000;

/** Output budget of one answer, shared by thinking and visible text. */
export const CLAUDE_MAX_TOKENS = 16000;

/**
 * One client per call: the key is read from the settings file each time, so a changed key applies at once.
 * No automatic retry by default: a slow paid call must not be sent twice behind the user's back.
 */
export function makeClient(apiKey: string, opts: { fetchImpl?: typeof fetch; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_API_URL, fetch: opts.fetchImpl, maxRetries: opts.maxRetries ?? 0, timeout: CLAUDE_TIMEOUT_MS });
}

export class RefusedError extends Error {
  constructor() {
    super('the model declined to answer this request');
    this.name = 'RefusedError';
  }
}

export type RunResult = { text: string; model: string; stopReason: string | null; truncated: boolean; inputTokens: number; outputTokens: number };

/** Sends one ready-made prompt and returns the text of the answer (thinking blocks are left out). */
export async function runPrompt(client: Anthropic, args: { model: string; effort: Effort; prompt: string; signal?: AbortSignal }): Promise<RunResult> {
  const message = await client.messages.create(
    { model: args.model, max_tokens: CLAUDE_MAX_TOKENS, output_config: { effort: args.effort }, messages: [{ role: 'user', content: args.prompt }] },
    { signal: args.signal },
  );
  if (message.stop_reason === 'refusal') throw new RefusedError();
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  return { text, model: message.model, stopReason: message.stop_reason, truncated: message.stop_reason === 'max_tokens', inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

export type KeyCheck = { ok: true } | { ok: false; code: 'rejected' | 'unexpected' | 'unreachable'; status?: number };

/** The cheapest authenticated call: listing one model proves the key is accepted. The error text is never kept (it could echo request details). */
export async function checkClaudeKey(apiKey: string, fetchImpl?: typeof fetch): Promise<KeyCheck> {
  try {
    await makeClient(apiKey, { fetchImpl, maxRetries: 0 }).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, code: 'unreachable' };
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, code: 'rejected', status: err.status };
    if (err instanceof Anthropic.APIError) return { ok: false, code: 'unexpected', status: err.status };
    return { ok: false, code: 'unreachable' };
  }
}
