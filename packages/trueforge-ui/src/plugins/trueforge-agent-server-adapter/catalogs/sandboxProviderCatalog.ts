/**
 * Maps trueforge-ui sandbox-settings calls onto Harness
 * `/api/v1/settings/sandbox-providers` (singleton upsert, no delete).
 *
 * UI: multi-row providers with `id` / `catalogId` / `name` / flat `apiKey`.
 * Harness: one provider per tenant; catalog YAML has no name — synthetic
 * identity uses `type` (`daytona` / `e2b`) as id/catalogId and display name.
 */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  SandboxCatalogServer,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
  SandboxProviderListEntry,
} from '../../../server/types.js';

export type UiSandboxProvider = SandboxProviderBase;
export type UiSandboxProviderCatalogEntry = SandboxProviderCatalogEntry;
export type UiSandboxProviderListEntry = SandboxProviderListEntry;

const DAYTONA_TYPE = 'daytona';
const E2B_TYPE = 'e2b';
const DAYTONA_DISPLAY_NAME = 'Daytona';
const E2B_DISPLAY_NAME = 'E2B';

/** UI SandboxConfig keeps Daytona lifecycle fields; E2B maps lifetime onto autoStop. */
const E2B_UNUSED_LIFECYCLE_MINUTES = 0;

function displayNameForType(type: string): string {
  switch (type) {
    case DAYTONA_TYPE:
      return DAYTONA_DISPLAY_NAME;
    case E2B_TYPE:
      return E2B_DISPLAY_NAME;
    default:
      return type;
  }
}

export function configFromHarness(
  provider: TrueForgeApi.CatalogSandboxProvider | TrueForgeApi.SandboxProviderManifest,
): SandboxProviderConfig {
  if (provider.type === DAYTONA_TYPE) {
    return {
      execTimeoutMs: provider.execTimeoutMs,
      autoStopIntervalInMinutes: provider.autoStopIntervalInMinutes,
      autoArchiveIntervalInMinutes: provider.autoArchiveIntervalInMinutes,
      autoDeleteIntervalInMinutes: provider.autoDeleteIntervalInMinutes,
    };
  }
  if (provider.type === E2B_TYPE) {
    return {
      execTimeoutMs: provider.execTimeoutMs,
      autoStopIntervalInMinutes: Math.max(1, Math.round(provider.sandboxTimeoutMs / 60_000)),
      autoArchiveIntervalInMinutes: E2B_UNUSED_LIFECYCLE_MINUTES,
      autoDeleteIntervalInMinutes: E2B_UNUSED_LIFECYCLE_MINUTES,
    };
  }
  const _exhaustive: never = provider;
  throw new Error(`Unsupported sandbox provider type: ${JSON.stringify(_exhaustive)}`);
}

export function toUiCatalogEntry(provider: TrueForgeApi.CatalogSandboxProvider): UiSandboxProviderCatalogEntry {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    type: provider.type,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProvider(provider: TrueForgeApi.SandboxProviderManifest): UiSandboxProvider {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    catalogId: provider.type,
    isConnected: true,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProviderListEntry(
  response: TrueForgeApi.GetSandboxProviderResponse['data'],
): UiSandboxProviderListEntry {
  return {
    data: toUiSandboxProvider(response.manifest),
    snapshotSyncStatus: {
      status: response.status,
      ...(response.statusReason ? { statusReason: response.statusReason } : {}),
    },
  };
}

export function filterUiSandboxProviders({
  providers,
  query,
}: {
  providers: UiSandboxProviderListEntry[];
  query?: string;
}): UiSandboxProviderListEntry[] {
  const normalizedQuery = query?.trim().toLowerCase();
  if (normalizedQuery === undefined || normalizedQuery === '') {
    return providers;
  }
  return providers.filter(
    provider =>
      provider.data.name.toLowerCase().includes(normalizedQuery) ||
      provider.data.id.toLowerCase().includes(normalizedQuery),
  );
}

export function toHarnessManifest(
  req: {
    type: string;
    apiKey: string;
  } & SandboxProviderConfig,
): TrueForgeApi.SandboxProviderManifest {
  if (req.type === DAYTONA_TYPE) {
    return {
      type: DAYTONA_TYPE,
      execTimeoutMs: req.execTimeoutMs,
      autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
      autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
      autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
      auth: { apiKey: req.apiKey },
    };
  }
  if (req.type === E2B_TYPE) {
    return {
      type: E2B_TYPE,
      execTimeoutMs: req.execTimeoutMs,
      sandboxTimeoutMs: Math.max(60_000, req.autoStopIntervalInMinutes * 60_000),
      auth: { apiKey: req.apiKey },
    };
  }
  throw new Error(`Unsupported sandbox provider type: ${req.type}`);
}

/** Settings sandbox-catalog port for `createTrueFoundryServer`. Delete omitted (no BE route). */
export function createSandboxProviderCatalog(client: TrueForge): SandboxCatalogServer {
  async function resolveApiKey(apiKey: string | undefined): Promise<string> {
    const trimmed = apiKey?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      return trimmed;
    }
    const existing = await client.settings.sandboxProviders.get();
    return existing.data.manifest.auth.apiKey;
  }

  return {
    getSandboxProviderCatalog: async () => {
      const body = await client.catalogs.sandboxProviders.list();
      return body.data.map(toUiCatalogEntry);
    },
    listSandboxProviders: async req => {
      let providers: UiSandboxProviderListEntry[];
      try {
        const body = await client.settings.sandboxProviders.get();
        providers = [toUiSandboxProviderListEntry(body.data)];
      } catch (err) {
        if (err instanceof TrueForgeApi.NotFoundError) {
          providers = [];
        } else {
          throw err;
        }
      }
      return filterUiSandboxProviders({ providers, query: req?.query });
    },
    createSandboxProvider: async req => {
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type: req.type,
          apiKey: req.apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
    updateSandboxProvider: async req => {
      const existing = await client.settings.sandboxProviders.get();
      const apiKey = await resolveApiKey(req.apiKey);
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type: existing.data.manifest.type,
          apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
  };
}
