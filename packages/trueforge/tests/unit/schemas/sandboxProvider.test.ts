import {
  StoredSandboxProviderManifestSchema,
  UpdateSandboxProviderRequestSchema,
  toDaytonaSandboxProviderInput,
  toE2BSandboxProviderInput,
  type DaytonaSandboxProvider,
  type E2BSandboxProvider,
} from '../../../src/schemas/sandboxProvider';

describe('toDaytonaSandboxProviderInput', () => {
  it('maps a Daytona wire/DB manifest to apiKey plus provider settings', () => {
    const manifest: DaytonaSandboxProvider = {
      type: 'daytona',
      auth: { api_key: 'dtn-test' },
      exec_timeout_ms: 60_000,
      auto_stop_interval_in_minutes: 5,
      auto_archive_interval_in_minutes: 60,
      auto_delete_interval_in_minutes: 7200,
    };

    expect(toDaytonaSandboxProviderInput(manifest)).toEqual({
      apiKey: 'dtn-test',
      timeoutMs: 60_000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
  });
});

describe('toE2BSandboxProviderInput', () => {
  it('maps an E2B wire/DB manifest to apiKey plus provider settings', () => {
    const manifest: E2BSandboxProvider = {
      type: 'e2b',
      auth: { api_key: 'e2b-test' },
      exec_timeout_ms: 60_000,
      sandbox_timeout_ms: 300_000,
    };

    expect(toE2BSandboxProviderInput(manifest)).toEqual({
      apiKey: 'e2b-test',
      timeoutMs: 60_000,
      sandboxTimeoutMs: 300_000,
    });
  });
});

describe('StoredSandboxProviderManifestSchema', () => {
  it('parses a truefoundry manifest for internal store use', () => {
    expect(
      StoredSandboxProviderManifestSchema.parse({
        type: 'truefoundry',
        server_url: 'http://sandbox-server',
        nats_bridge_url: 'ws://nats-bridge',
        exec_timeout_ms: 60_000,
      }),
    ).toEqual({
      type: 'truefoundry',
      server_url: 'http://sandbox-server',
      nats_bridge_url: 'ws://nats-bridge',
      exec_timeout_ms: 60_000,
    });
  });

  it('parses an e2b manifest for store use', () => {
    expect(
      StoredSandboxProviderManifestSchema.parse({
        type: 'e2b',
        auth: { api_key: 'e2b-test' },
        exec_timeout_ms: 60_000,
        sandbox_timeout_ms: 300_000,
      }),
    ).toEqual({
      type: 'e2b',
      auth: { api_key: 'e2b-test' },
      exec_timeout_ms: 60_000,
      sandbox_timeout_ms: 300_000,
    });
  });
});

describe('UpdateSandboxProviderRequestSchema', () => {
  it('rejects a truefoundry manifest (settings PUT is Daytona/E2B only)', () => {
    expect(() =>
      UpdateSandboxProviderRequestSchema.parse({
        manifest: {
          type: 'truefoundry',
          server_url: 'http://sandbox-server',
          nats_bridge_url: 'ws://nats-bridge',
          exec_timeout_ms: 60_000,
        },
      }),
    ).toThrow();
  });

  it('accepts an e2b manifest', () => {
    expect(
      UpdateSandboxProviderRequestSchema.parse({
        manifest: {
          type: 'e2b',
          auth: { api_key: 'e2b-test' },
          exec_timeout_ms: 60_000,
          sandbox_timeout_ms: 300_000,
        },
      }),
    ).toMatchObject({
      manifest: { type: 'e2b' },
    });
  });
});
