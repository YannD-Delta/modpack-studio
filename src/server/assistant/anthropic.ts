import Anthropic from '@anthropic-ai/sdk';
import type { Effort } from '../settings/secrets-store.js';

/** One client per call: the key is read from the settings file each time, so a changed key applies at once. */
export function makeClient(apiKey: string, opts: { fetchImpl?: typeof fetch; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({ apiKey, fetch: opts.fetchImpl, maxRetries: opts.maxRetries ?? 1, timeout: 5 * 60 * 1000 });
}

export class RefusedError extends Error {
  constructor() {
    super('the model declined to answer this request');
    this.name = 'RefusedError';
  }
}

export type RunResult = { text: string; model: string; stopReason: string | null; inputTokens: number; outputTokens: number };

/** Sends one ready-made prompt and returns the text of the answer (thinking blocks are left out). */
export async function runPrompt(client: Anthropic, args: { model: string; effort: Effort; prompt: string }): Promise<RunResult> {
  const message = await client.messages.create({
    model: args.model,
    max_tokens: 16000,
    output_config: { effort: args.effort },
    messages: [{ role: 'user', content: args.prompt }],
  });
  if (message.stop_reason === 'refusal') throw new RefusedError();
  const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  return { text, model: message.model, stopReason: message.stop_reason, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
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
