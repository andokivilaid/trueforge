/**
 * @jest-environment node
 */
import { makeSilentLogger } from '../harnessMocks';

jest.mock('e2b', () => {
  class AuthenticationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthenticationError';
    }
  }
  class SandboxNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'SandboxNotFoundError';
    }
  }
  const mockExists = jest.fn();
  const mockBuildInBackground = jest.fn();
  const mockRunCmd = jest.fn(() => ({ mocked: true }));
  const mockFromImage = jest.fn(() => ({
    runCmd: mockRunCmd,
  }));
  const mockConnect = jest.fn();
  const Template = Object.assign(
    () => ({
      fromImage: mockFromImage,
    }),
    {
      exists: mockExists,
      buildInBackground: mockBuildInBackground,
    },
  );
  return {
    AuthenticationError,
    SandboxNotFoundError,
    Template,
    Sandbox: { connect: mockConnect },
    CommandExitError: class CommandExitError extends Error {},
    FileNotFoundError: class FileNotFoundError extends Error {},
    FileType: { FILE: 'file', DIR: 'dir', SYMLINK: 'symlink' },
    __mocks: { mockExists, mockBuildInBackground, mockFromImage, mockRunCmd, mockConnect },
  };
});

import { AuthenticationError, SandboxNotFoundError } from 'e2b';
import { E2BSandboxProvider, isE2BAuthError } from '../../../src/core/sandbox/provider/E2BSandboxProvider';
import { SandboxNotAvailableError } from '../../../src/core/sandbox/SandboxErrors';

const { __mocks } = jest.requireMock('e2b') as {
  __mocks: {
    mockExists: jest.Mock;
    mockBuildInBackground: jest.Mock;
    mockFromImage: jest.Mock;
    mockRunCmd: jest.Mock;
    mockConnect: jest.Mock;
  };
};

afterEach(() => {
  jest.clearAllMocks();
});

function makeProvider(overrides?: { buildRef?: string; templateId?: string; buildId?: string }): E2BSandboxProvider {
  return new E2BSandboxProvider({
    apiKey: 'e2b-test',
    tenantName: 'test-tenant',
    sandboxImage: 'registry.example.com/sandbox:029ea5ff',
    timeoutMs: 1000,
    sandboxTimeoutMs: 300_000,
    fileMaxBytesForDownload: 1024,
    logger: makeSilentLogger(),
    ...overrides,
  });
}

describe('isE2BAuthError', () => {
  it('matches AuthenticationError', () => {
    expect(isE2BAuthError(new AuthenticationError('bad key'))).toBe(true);
    expect(isE2BAuthError(new Error('nope'))).toBe(false);
  });
});

describe('E2BSandboxProvider buildImage', () => {
  it('starts a background template build when the name is missing', async () => {
    __mocks.mockExists.mockResolvedValue(false);
    __mocks.mockBuildInBackground.mockResolvedValue({
      alias: 'trueforge-build-029ea5ff',
      name: 'trueforge-build-029ea5ff',
      tags: [],
      templateId: 'tpl-1',
      buildId: 'bld-1',
    });

    const build = await makeProvider().buildImage();

    expect(build.status).toBe('pending');
    expect(build.metadata).toEqual({
      build_ref: 'trueforge-build-029ea5ff',
      image_uri: 'registry.example.com/sandbox:029ea5ff',
      template_id: 'tpl-1',
      build_id: 'bld-1',
    });
    expect(__mocks.mockBuildInBackground).toHaveBeenCalledTimes(1);
    expect(__mocks.mockFromImage).toHaveBeenCalledWith('registry.example.com/sandbox:029ea5ff');
    expect(__mocks.mockRunCmd).toHaveBeenCalledWith(
      'mkdir -p /opt/tf /usr/local/bin && chmod 1777 /opt/tf',
      { user: 'root' },
    );
  });

  it('treats a concurrent-create race as pending when the template appears', async () => {
    __mocks.mockExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    __mocks.mockBuildInBackground.mockRejectedValue(new Error('already exists'));

    const build = await makeProvider().buildImage();

    expect(build.status).toBe('pending');
    expect(__mocks.mockExists).toHaveBeenCalledTimes(2);
  });

  it('reports ready when the template already exists without local build ids', async () => {
    __mocks.mockExists.mockResolvedValue(true);

    const build = await makeProvider().buildImage();

    expect(build).toEqual({
      status: 'ready',
      reason: null,
      metadata: {
        build_ref: 'trueforge-build-029ea5ff',
        image_uri: 'registry.example.com/sandbox:029ea5ff',
      },
    });
  });
});

describe('E2BSandboxProvider exec', () => {
  it('rethrows SandboxNotAvailableError when the sandbox is gone', async () => {
    __mocks.mockConnect.mockRejectedValue(new SandboxNotFoundError('gone'));

    const provider = makeProvider({ buildRef: 'trueforge-build-029ea5ff' });
    await expect(provider.exec({ sandboxId: 'sbx-missing', command: 'true' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  });
});
