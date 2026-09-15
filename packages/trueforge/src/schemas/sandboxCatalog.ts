/**
 * Shipped sandbox-catalog.yaml schemas (discovery presets). Separate from
 * configured provider manifests in sandboxProvider.ts.
 */
import { z } from '@hono/zod-openapi';
import { DaytonaSandboxProviderSchema, E2BSandboxProviderSchema } from './sandboxProvider';

const CatalogDaytonaSandboxProviderSchema = DaytonaSandboxProviderSchema.omit({ auth: true }).strict();
const CatalogE2BSandboxProviderSchema = E2BSandboxProviderSchema.omit({ auth: true }).strict();

/** Catalog wire type — Daytona | E2B presets the UI copies into PUT bodies. */
export const CatalogSandboxProviderSchema = z
  .discriminatedUnion('type', [CatalogDaytonaSandboxProviderSchema, CatalogE2BSandboxProviderSchema])
  .openapi('CatalogSandboxProvider');

export const SandboxCatalogFileSchema = z
  .object({
    providers: z.array(CatalogSandboxProviderSchema),
  })
  .strict();

export const GetSandboxProviderCatalogResponseSchema = z
  .object({
    data: z.array(CatalogSandboxProviderSchema),
  })
  .openapi('GetSandboxProviderCatalogResponse');

export type CatalogSandboxProvider = z.infer<typeof CatalogSandboxProviderSchema>;
export type SandboxCatalogFile = z.infer<typeof SandboxCatalogFileSchema>;
