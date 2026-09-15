import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
  Template,
  type BuildInfo,
  type Sandbox as E2BSandbox,
} from 'e2b';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { join } from 'node:path/posix';
import type { Logger } from 'winston';
import { extractErrorLogFields } from '../../util/errorLogFields';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '../SandboxErrors';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import { CodeModeNatsTransport } from '../codeMode/nats/CodeModeNatsTransport';
import { DEFAULT_SANDBOX_NATS_WS_PORT } from '../constants';
import type { ExecResult, SandboxBuild, SandboxExecParams, SandboxFileInfo, SandboxProvider } from './Provider';

const IMAGE_BUILD_NAME_PREFIX = 'trueforge-build-';
/**
 * E2B's default sandbox user cannot write under `/opt` or `/usr/local/bin`.
 * Daytona runs layout/init as root; match that so mkdir `/opt/tf` and mcp-client symlinks succeed.
 */
const E2B_LAYOUT_USER = 'root';

/**
 * Digest portion of a container image reference (the tag/digest after the final `:`).
 * The release image is always published with an explicit digest tag.
 */
function imageDigest(image: string): string {
  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon === -1) {
    throw new Error(`Sandbox image reference has no tag/digest: ${image}`);
  }
  return lastSegment.slice(colon + 1);
}

/** Deterministic template name per image digest so every server replica converges on one build. */
function deriveImageBuildName(digest: string): string {
  return `${IMAGE_BUILD_NAME_PREFIX}${digest}`;
}

function combineCommandOutput(result: { stdout: string; stderr: string }): string {
  if (result.stdout.length === 0) {
    return result.stderr;
  }
  if (result.stderr.length === 0) {
    return result.stdout;
  }
  return `${result.stdout}${result.stderr}`;
}

export interface E2BSandboxProviderOptions {
  apiKey: string;
  tenantName: string;
  /** Release-owned sandbox image reference; built into an E2B template and cloned per sandbox. */
  sandboxImage: string;
  /**
   * E2B template name to create sandboxes from. When omitted it is derived from the image digest.
   * Callers that create sandboxes pass the persisted build_ref so cloning targets the template
   * that was actually built.
   */
  buildRef?: string | undefined;
  /** Prior build ids from `build_metadata`, used to poll Template.getBuildStatus. */
  templateId?: string | undefined;
  buildId?: string | undefined;
  /** Default command exec timeout. */
  timeoutMs: number;
  /** E2B sandbox lifetime (`Sandbox.create` `timeoutMs`). */
  sandboxTimeoutMs: number;
  fileMaxBytesForDownload: number;
  /** Optional private-registry credentials for `Template.fromImage`. */
  imageRegistry?: { username: string; password: string } | undefined;
  /** Defaults to the built-in sandbox NATS WebSocket port (4444). */
  natsBridgePort?: number | undefined;
  logger: Logger;
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly type = 'e2b';
  private readonly apiKey: string;
  private readonly tenantName: string;
  private readonly imageUri: string;
  private readonly buildRef: string;
  private readonly templateId: string | undefined;
  private readonly buildId: string | undefined;
  private readonly timeoutMs: number;
  private readonly sandboxTimeoutMs: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly imageRegistry: { username: string; password: string } | undefined;
  private readonly natsBridgePort: number;
  private readonly logger: Logger;
  private static readonly cachedSandboxes = new Map<string, E2BSandbox>();

  constructor(options: E2BSandboxProviderOptions) {
    this.apiKey = options.apiKey;
    this.tenantName = options.tenantName;
    this.imageUri = options.sandboxImage;
    this.buildRef = options.buildRef ?? deriveImageBuildName(imageDigest(options.sandboxImage));
    this.templateId = options.templateId;
    this.buildId = options.buildId;
    this.timeoutMs = options.timeoutMs;
    this.sandboxTimeoutMs = options.sandboxTimeoutMs;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload;
    this.imageRegistry = options.imageRegistry;
    this.natsBridgePort = options.natsBridgePort ?? DEFAULT_SANDBOX_NATS_WS_PORT;
    this.logger = options.logger.child({ module: 'E2BSandboxProvider' });
  }

  private connectionOpts(): { apiKey: string } {
    return { apiKey: this.apiKey };
  }

  private buildMetadata(extra?: { template_id?: string; build_id?: string }): Record<string, string> {
    return {
      build_ref: this.buildRef,
      image_uri: this.imageUri,
      ...(extra?.template_id === undefined ? {} : { template_id: extra.template_id }),
      ...(extra?.build_id === undefined ? {} : { build_id: extra.build_id }),
      ...(this.templateId === undefined || extra?.template_id !== undefined ? {} : { template_id: this.templateId }),
      ...(this.buildId === undefined || extra?.build_id !== undefined ? {} : { build_id: this.buildId }),
    };
  }

  private toBuildFromStatus(status: string, reason: string | null, metadata: Record<string, string>): SandboxBuild {
    switch (status) {
      case 'ready':
        return { status: 'ready', reason: null, metadata };
      case 'error':
        return { status: 'failed', reason: reason ?? 'Sandbox image build failed (error).', metadata };
      default:
        return { status: 'pending', reason: reason ?? `Sandbox image build in progress (${status}).`, metadata };
    }
  }

  private async pollBuildStatus(params: { templateId: string; buildId: string }): Promise<SandboxBuild> {
    const metadata = this.buildMetadata({ template_id: params.templateId, build_id: params.buildId });
    const response = await Template.getBuildStatus(
      { templateId: params.templateId, buildId: params.buildId },
      this.connectionOpts(),
    );
    return this.toBuildFromStatus(response.status, response.reason?.message ?? null, metadata);
  }

  async buildImage(): Promise<SandboxBuild> {
    const exists = await Template.exists(this.buildRef, this.connectionOpts());
    if (exists) {
      if (this.templateId !== undefined && this.buildId !== undefined) {
        return await this.pollBuildStatus({ templateId: this.templateId, buildId: this.buildId });
      }
      // Name already present without local build ids — treat as ready (prior successful build).
      return { status: 'ready', reason: null, metadata: this.buildMetadata() };
    }

    // Pre-create the absolute layout dirs the harness expects (same as Daytona image layout).
    const templateBase =
      this.imageRegistry === undefined
        ? Template().fromImage(this.imageUri)
        : Template().fromImage(this.imageUri, this.imageRegistry);
    const template = templateBase.runCmd('mkdir -p /opt/tf /usr/local/bin && chmod 1777 /opt/tf', {
      user: E2B_LAYOUT_USER,
    });

    let buildInfo: BuildInfo;
    try {
      buildInfo = await Template.buildInBackground(template, this.buildRef, this.connectionOpts());
    } catch (error) {
      // A concurrent replica may have started the same deterministic name.
      if (await Template.exists(this.buildRef, this.connectionOpts())) {
        this.logger.info(`E2B template already created concurrently: name=${this.buildRef}`);
        return {
          status: 'pending',
          reason: 'Sandbox image build started by another server replica.',
          metadata: this.buildMetadata(),
        };
      }
      throw error;
    }

    return {
      status: 'pending',
      reason: 'Sandbox image build in progress.',
      metadata: this.buildMetadata({ template_id: buildInfo.templateId, build_id: buildInfo.buildId }),
    };
  }

  async getImageBuildStatus(): Promise<SandboxBuild> {
    if (this.templateId !== undefined && this.buildId !== undefined) {
      return await this.pollBuildStatus({ templateId: this.templateId, buildId: this.buildId });
    }

    const exists = await Template.exists(this.buildRef, this.connectionOpts());
    if (!exists) {
      return {
        status: 'pending',
        reason: 'Sandbox image build not started.',
        metadata: this.buildMetadata(),
      };
    }
    return { status: 'ready', reason: null, metadata: this.buildMetadata() };
  }

  private async getOrCreateSandbox(sandboxId?: string): Promise<E2BSandbox> {
    if (sandboxId !== undefined) {
      const cached = E2BSandboxProvider.cachedSandboxes.get(sandboxId);
      if (cached) {
        return cached;
      }
      try {
        const sandbox = await Sandbox.connect(sandboxId, this.connectionOpts());
        E2BSandboxProvider.cachedSandboxes.set(sandboxId, sandbox);
        return sandbox;
      } catch (error) {
        if (error instanceof SandboxNotFoundError) {
          throw new SandboxNotAvailableError(sandboxId);
        }
        throw error;
      }
    }

    // secure:false so Code Mode can open the NATS preview host without a traffic-access header.
    const sandbox = await Sandbox.create(this.buildRef, {
      ...this.connectionOpts(),
      timeoutMs: this.sandboxTimeoutMs,
      secure: false,
      metadata: { trueforge_tenant: this.tenantName },
    });
    E2BSandboxProvider.cachedSandboxes.set(sandbox.sandboxId, sandbox);
    return sandbox;
  }

  async createSandbox(): Promise<{ sandboxId: string }> {
    return context.with(suppressTracing(context.active()), async () => {
      const sandbox = await this.getOrCreateSandbox();
      this.logger.debug(`Sandbox created: id=${sandbox.sandboxId}`);
      return { sandboxId: sandbox.sandboxId };
    });
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    return context.with(suppressTracing(context.active()), async (): Promise<ExecResult> => {
      try {
        const sandbox = await this.getOrCreateSandbox(params.sandboxId);
        const timeoutMs =
          params.timeoutSeconds === undefined ? this.timeoutMs : params.timeoutSeconds * 1000;
        try {
          const response = await sandbox.commands.run(params.command, {
            ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
            envs: params.env ?? {},
            timeoutMs,
            user: E2B_LAYOUT_USER,
          });
          return {
            success: true,
            response: { exitCode: response.exitCode, result: combineCommandOutput(response) },
          };
        } catch (error) {
          if (error instanceof CommandExitError) {
            return {
              success: true,
              response: { exitCode: error.exitCode, result: combineCommandOutput(error) },
            };
          }
          throw error;
        }
      } catch (e: unknown) {
        E2BSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        if (e instanceof SandboxNotAvailableError) {
          throw e;
        }
        this.logger.error('Sandbox execution error', extractErrorLogFields(e));
        const message = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, error: message };
      }
    });
  }

  private async getFileInfo(sandbox: E2BSandbox, path: string): Promise<SandboxFileInfo> {
    const details = await sandbox.files.getInfo(path, { user: E2B_LAYOUT_USER });
    return { size: details.size, isDir: details.type === FileType.DIR };
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    return context.with(suppressTracing(context.active()), async () => {
      try {
        const sandbox = await this.getOrCreateSandbox(params.sandboxId);
        const info = await this.getFileInfo(sandbox, params.path);
        if (info.isDir) {
          throw new SandboxPathIsDirectoryError(params.path);
        }
        if (info.size > this.fileMaxBytesForDownload) {
          throw new SandboxFileTooLargeError(params.path, info.size, this.fileMaxBytesForDownload);
        }
        const bytes = await sandbox.files.read(params.path, { format: 'bytes', user: E2B_LAYOUT_USER });
        return Buffer.from(bytes);
      } catch (e: unknown) {
        if (e instanceof SandboxPathIsDirectoryError || e instanceof SandboxFileTooLargeError) {
          throw e;
        }
        if (e instanceof FileNotFoundError) {
          throw new SandboxFileNotFoundError(params.path);
        }
        E2BSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        throw e;
      }
    });
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    return context.with(suppressTracing(context.active()), async () => {
      try {
        const sandbox = await this.getOrCreateSandbox(params.sandboxId);
        const ab = new ArrayBuffer(params.content.byteLength);
        new Uint8Array(ab).set(params.content);
        await sandbox.files.write(params.remotePath, ab, { user: E2B_LAYOUT_USER });
      } catch (e: unknown) {
        E2BSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        throw e;
      }
    });
  }

  createCodeModeTransport(): CodeModeTransport {
    return new CodeModeNatsTransport({
      resolveHostUrl: async (sandboxId: string) => {
        const sandbox = await this.getOrCreateSandbox(sandboxId);
        return `wss://${sandbox.getHost(this.natsBridgePort)}`;
      },
      sandboxClientNatsUrl: `ws://localhost:${String(this.natsBridgePort)}`,
      logger: this.logger,
      mcpClientInstall: {
        remotePath: join('/opt', 'tf', 'mcp-client', 'mcp_client.py'),
        pathBinSymlink: join('/usr', 'local', 'bin', 'mcp-client'),
      },
    });
  }

  getAdditionalInstructions(): string | undefined {
    return undefined;
  }

  // Same absolute layout as Daytona — image ships /opt/tf and mcp-client on PATH.
  getToolResultDumpDir(): string {
    return join('/opt', 'tf', 'tool-results');
  }

  getGitCredentialsPath(): string {
    return join('/opt', 'tf', '.git-credentials');
  }

  getFileUploadsDir(): string {
    return join('/opt', 'tf', 'uploads');
  }

  getSkillsDir(): string {
    return join('/opt', 'tf', 'skills');
  }

  getSkillDownloaderPath(): string {
    return join('/opt', 'tf', 'skill_downloader.py');
  }
}

/** E2B rejected the credentials; retrying the same key cannot succeed. */
export function isE2BAuthError(error: unknown): boolean {
  return error instanceof AuthenticationError;
}
