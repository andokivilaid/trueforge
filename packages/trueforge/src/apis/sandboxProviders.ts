import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { withTimeout } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISandboxProviderStore, SandboxProviderRecord } from '../db/sandboxProviderStore';
import type { WithTransaction } from '../db/transaction';
import { getSandboxProviderRoute, putSandboxProviderRoute } from '../routes/sandboxProviderRoutes';
import {
  checkSnapshotStatus,
  isDaytonaAuthError,
  isDaytonaPermissionError,
  isE2BAuthError,
  toDaytonaSandboxProvider,
  toE2BSandboxProvider,
  toSandboxStatus,
} from '../sandbox/providerUtils';
import type { SandboxProviderManifest, UpdateSandboxProviderRequest } from '../schemas/sandboxProvider';
import { MissingStoredSecretError, resolveStoredSecretValue, toRedactedSecretValue } from '../utils/secretRedaction';

/** Cap the register round-trip so a slow/unreachable provider can't hold the request (or DB txn) open. */
const BUILD_REQUEST_TIMEOUT_MS = 3_000;

export interface SandboxProvidersRouterDeps<TTransaction> {
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  logger: Logger;
  resolveRequestContext: ResolveRequestContext;
}

function redactSandboxProvider(manifest: SandboxProviderManifest): SandboxProviderManifest {
  return {
    ...manifest,
    auth: { api_key: toRedactedSecretValue(manifest.auth.api_key) },
  };
}

function resolveApiKey({
  incoming,
  existing,
}: {
  incoming: string;
  existing: SandboxProviderRecord | undefined;
}): string {
  const existingKey =
    existing?.manifest.type === 'daytona' || existing?.manifest.type === 'e2b'
      ? existing.manifest.auth.api_key
      : undefined;
  return resolveStoredSecretValue({ incoming, existing: existingKey });
}

function buildProviderForManifest({
  manifest,
  tenant_id,
  logger,
  build_metadata,
}: {
  manifest: SandboxProviderManifest;
  tenant_id: string;
  logger: Logger;
  build_metadata?: SandboxProviderRecord['build_metadata'];
}) {
  switch (manifest.type) {
    case 'daytona':
      return toDaytonaSandboxProvider({
        manifest,
        tenant_id,
        logger,
        ...(build_metadata !== undefined ? { build_metadata } : {}),
      });
    case 'e2b':
      return toE2BSandboxProvider({
        manifest,
        tenant_id,
        logger,
        ...(build_metadata !== undefined ? { build_metadata } : {}),
      });
    default: {
      const _exhaustive: never = manifest;
      throw new Error(`Unsupported sandbox provider type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Admin/settings sandbox provider surface (mounted at /api/v1/settings/sandbox-providers). */
export function createSandboxProvidersRouter<TTransaction>(deps: SandboxProvidersRouterDeps<TTransaction>) {
  const getHandler: RouteHandler<typeof getSandboxProviderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const record = await store.getSandboxProvider(requestContext.tenant_id);
    if (record?.manifest.type !== 'daytona' && record?.manifest.type !== 'e2b') {
      return c.json({ error: { message: 'No sandbox provider configured' } }, 404);
    }
    // Refresh the persisted build status (and re-activate an idle snapshot) on every GET.
    const status = await checkSnapshotStatus({
      store,
      tenant_id: requestContext.tenant_id,
      logger: deps.logger,
    });
    return c.json(
      {
        data: {
          manifest: redactSandboxProvider(record.manifest),
          status: status?.status ?? record.status,
          status_reason: status?.status_reason ?? record.status_reason,
        },
      },
      200,
    );
  };

  const putHandler: RouteHandler<typeof putSandboxProviderRoute> = async c => {
    const body: UpdateSandboxProviderRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const store = deps.resolveSandboxProviderStore(c);
    const incoming = body.manifest;
    const resolveManifest = (existing: SandboxProviderRecord | undefined): SandboxProviderManifest => ({
      ...incoming,
      auth: {
        api_key: resolveApiKey({ incoming: incoming.auth.api_key, existing }),
      },
    });
    try {
      // NOTE: build (provider network I/O) runs inside the transaction for now; the design is being revisited.
      const { manifest, status } = await deps.withTransaction(async transaction => {
        const locked = await store.getSandboxProviderForUpdate(requestContext.tenant_id, transaction);
        const resolved = resolveManifest(locked);
        // Pass persisted build_metadata so a settings re-save does not start a new snapshot/template for a
        // bumped SANDBOX_IMAGE_URI (upgrades are unsupported — first configure has no metadata).
        // When switching provider type, drop old metadata so the new backend builds fresh.
        const build_metadata =
          locked !== undefined && locked.manifest.type === resolved.type ? locked.build_metadata : undefined;
        const provider = buildProviderForManifest({
          manifest: resolved,
          tenant_id: requestContext.tenant_id,
          logger: deps.logger,
          ...(build_metadata !== undefined ? { build_metadata } : {}),
        });
        const built = toSandboxStatus(
          await withTimeout(provider.buildImage(), BUILD_REQUEST_TIMEOUT_MS, 'sandbox buildImage'),
        );
        await store.upsertSandboxProvider(
          { tenant_id: requestContext.tenant_id, manifest: resolved, ...built },
          transaction,
        );
        return { manifest: resolved, status: built };
      });
      return c.json(
        {
          data: {
            manifest: redactSandboxProvider(manifest),
            status: status.status,
            status_reason: status.status_reason,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof MissingStoredSecretError) {
        return c.json({ error: { message: 'API key is required' } }, 400);
      }
      if (isDaytonaAuthError(error) || isE2BAuthError(error)) {
        const label = isE2BAuthError(error) ? 'E2B' : 'Daytona';
        return c.json({ error: { message: `${label} rejected the API key — check the credentials` } }, 422);
      }
      if (isDaytonaPermissionError(error)) {
        return c.json(
          {
            error: {
              message:
                'Daytona denied access: the API key is missing required permissions. Grant write:sandboxes, write:snapshots, and delete:snapshots on the key in the Daytona dashboard, then try again.',
            },
          },
          422,
        );
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(getSandboxProviderRoute, getHandler);
  router.openapi(putSandboxProviderRoute, putHandler);
  return router;
}
