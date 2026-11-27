// Provider for any OpenAI-compatible /images/edits endpoint. Storage is yours: pass read and write functions.

import type { Provider } from './gateway.ts';

export type ImageStorage = {
  read: (path: string) => Promise<Blob>;
  write: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
};

export function imageEditProvider(opts: {
  apiKey: string; storage: ImageStorage; model?: string; baseUrl?: string;
  /** Price per image in USD. Leave 0 until you know it: results are then marked pricePending. */
  costUsdPerImage?: number; outPath?: (input: Record<string, unknown>) => string; fetchImpl?: typeof fetch;
}): Provider {
  const model = opts.model ?? 'gpt-image-1';
  const base = opts.baseUrl ?? 'https://api.openai.com/v1';
  const perImage = opts.costUsdPerImage ?? 0;
  const f = opts.fetchImpl ?? fetch;
  return {
    name: 'image-edit', model,
    run: async (input) => {
      const paths = [String(input.sourcePath), ...((input.referencePaths as string[]) ?? [])];
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', String(input.prompt));
      for (const p of paths) form.append('image[]', await opts.storage.read(p), p.split('/').pop() || 'image.png');
      const r = await f(`${base}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${opts.apiKey}` }, body: form });
      if (!r.ok) throw Object.assign(new Error(`Image API ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
      const j = (await r.json()) as { data?: { b64_json?: string }[] };
      const b64 = j.data?.[0]?.b64_json;
      if (!b64) throw new Error('Image API returned no image');
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const out = opts.outPath ? opts.outPath(input) : `renders/${String(input.userId ?? 'anon')}/${Date.now()}.png`;
      await opts.storage.write(out, bytes, 'image/png');
      return { output: { path: out, pricePending: perImage === 0 }, costUsd: perImage };
    },
  };
}
