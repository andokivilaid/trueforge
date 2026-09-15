/**
 * Live model discovery against a configured provider's own API.
 *
 * The shipped catalog (catalog/model-catalog.yaml) is a hand-maintained preset list and goes stale
 * as providers ship models. Discovery asks the provider directly, so the model list — and the token
 * limits that drive context compaction — come from the source of truth instead of a checked-in file.
 *
 * The API key never leaves the server: callers pass a resolved manifest, not a client-supplied key.
 */
import type { ModelProviderManifest } from '../schemas/modelProvider';

/** A model the provider reports, shaped for the UI to copy into a manifest write. */
export interface DiscoveredModel {
  model_id: string;
  context_length?: number;
  max_output_tokens?: number;
}

export interface DiscoveryResult {
  models: DiscoveredModel[];
}

/** Discovery reached the provider but it refused, or the response was not usable. */
export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

/** The provider type has no discovery adapter; the caller falls back to catalog presets. */
export class ModelDiscoveryUnsupportedError extends Error {
  constructor(readonly providerType: string) {
    super(`Model discovery is not supported for provider type "${providerType}"`);
    this.name = 'ModelDiscoveryUnsupportedError';
  }
}

const DISCOVERY_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A positive integer, or undefined — provider payloads are untrusted and fields are optional. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelDiscoveryError(`Could not reach the provider: ${reason}`, { cause: error });
  }
  if (!response.ok) {
    // The body may carry the provider's own reason (bad key, disabled API); surface it, capped.
    const detail = await response.text().catch(() => '');
    throw new ModelDiscoveryError(
      `Provider returned ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ''}`.trim(),
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ModelDiscoveryError('Provider returned a response that was not JSON.', { cause: error });
  }
}

/**
 * Gemini's native list endpoint. Unlike the OpenAI-compatible shape it reports token limits, so
 * discovered Gemini models arrive with the properties that context compaction needs.
 */
async function discoverGoogleGemini(baseUrl: string, apiKey: string): Promise<DiscoveryResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  const payload = await fetchJson(url, {});
  if (!isRecord(payload) || !Array.isArray(payload['models'])) {
    throw new ModelDiscoveryError('Provider response did not contain a model list.');
  }
  const rawModels = payload['models'];

  const models: DiscoveredModel[] = [];
  for (const entry of rawModels) {
    if (!isRecord(entry)) {
      continue;
    }
    // Only models usable for chat; the list also carries embedding and TTS-only models.
    const methods = entry['supportedGenerationMethods'];
    if (!Array.isArray(methods) || !methods.includes('generateContent')) {
      continue;
    }
    const name = entry['name'];
    if (typeof name !== 'string' || name === '') {
      continue;
    }

    const contextLength = positiveInt(entry['inputTokenLimit']);
    const maxOutputTokens = positiveInt(entry['outputTokenLimit']);
    models.push({
      // The list returns "models/gemini-x"; the id sent on a request is the bare suffix.
      model_id: name.replace(/^models\//, ''),
      ...(contextLength !== undefined ? { context_length: contextLength } : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
    });
  }
  return { models };
}

/**
 * The OpenAI-compatible `GET /models`, which every remaining well-known provider speaks. It reports
 * ids only — no token limits — so models discovered this way carry no properties.
 */
async function discoverOpenAiCompatible(baseUrl: string, apiKey: string): Promise<DiscoveryResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const payload = await fetchJson(url, { Authorization: `Bearer ${apiKey}` });
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new ModelDiscoveryError('Provider response did not contain a model list.');
  }
  const rawModels = payload['data'];

  const models: DiscoveredModel[] = [];
  for (const entry of rawModels) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = entry['id'];
    if (typeof id === 'string' && id !== '') {
      models.push({ model_id: id });
    }
  }
  return { models };
}

function manifestBaseUrl(manifest: ModelProviderManifest): string | undefined {
  if (manifest.type === 'truefoundry') {
    return manifest.base_url;
  }
  if ('base_url' in manifest) {
    return manifest.base_url;
  }
  return undefined;
}

/**
 * Asks a configured provider which models it serves.
 *
 * @throws ModelDiscoveryUnsupportedError when the provider type has no adapter.
 * @throws ModelDiscoveryError when the provider is unreachable or rejects the request.
 */
export async function discoverProviderModels(manifest: ModelProviderManifest): Promise<DiscoveryResult> {
  const apiKey = manifest.auth?.api_key;
  if (apiKey === undefined || apiKey === '') {
    throw new ModelDiscoveryError('Provider has no stored API key to authenticate discovery.');
  }
  const baseUrl = manifestBaseUrl(manifest);
  if (baseUrl === undefined || baseUrl === '') {
    throw new ModelDiscoveryUnsupportedError(manifest.type);
  }

  if (manifest.type === 'google-gemini') {
    return discoverGoogleGemini(baseUrl, apiKey);
  }
  // `truefoundry` resolves its endpoint and token at runtime rather than from the manifest.
  if (manifest.type === 'truefoundry') {
    throw new ModelDiscoveryUnsupportedError(manifest.type);
  }
  return discoverOpenAiCompatible(baseUrl, apiKey);
}
