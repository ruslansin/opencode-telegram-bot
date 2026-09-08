import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  resolveLocalOpencodeTargetMock: vi.fn(),
  startLocalOpencodeServerMock: vi.fn(),
  notifyReadyMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      startOnDemand: false,
    },
  },
}));

vi.mock("../../src/config.js", () => ({
  config: mocked.config,
}));

vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: {
    global: {
      health: mocked.healthMock,
    },
  },
}));

vi.mock("../../src/opencode/process.js", () => ({
  resolveLocalOpencodeTarget: mocked.resolveLocalOpencodeTargetMock,
  startLocalOpencodeServer: mocked.startLocalOpencodeServerMock,
}));

vi.mock("../../src/opencode/ready-lifecycle.js", () => ({
  opencodeReadyLifecycle: {
    notifyReady: mocked.notifyReadyMock,
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: mocked.loggerInfoMock,
    warn: mocked.loggerWarnMock,
    error: mocked.loggerErrorMock,
  },
}));

import {
  ensureOpencodeServerRunning,
  setOnDemandStartNotifier,
} from "../../src/opencode/on-demand-start.js";
import { opencodeServerActivity } from "../../src/opencode/server-activity.js";
import { opencodeServerLifecycleLock } from "../../src/opencode/server-lifecycle-lock.js";

function createChildProcess(pid: number): ChildProcess {
  return {
    pid,
    once: vi.fn(),
    unref: vi.fn(),
  } as unknown as ChildProcess;
}

function healthyResponse() {
  return { data: { healthy: true, version: "1.2.3" }, error: null };
}

describe("opencode/on-demand-start", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    mocked.healthMock.mockReset();
    mocked.resolveLocalOpencodeTargetMock.mockReset();
    mocked.startLocalOpencodeServerMock.mockReset();
    mocked.notifyReadyMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerInfoMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerErrorMock.mockReset();

    mocked.config.opencode.apiUrl = "http://localhost:4096";
    mocked.config.opencode.startOnDemand = false;
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "localhost", port: 4096 });
    mocked.startLocalOpencodeServerMock.mockReturnValue(createChildProcess(123));
    mocked.notifyReadyMock.mockResolvedValue(true);
  });

  afterEach(() => {
    setOnDemandStartNotifier(null);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("does nothing when on-demand startup is disabled", async () => {
    const result = await ensureOpencodeServerRunning("prompt");

    expect(result).toBe(true);
    expect(mocked.healthMock).not.toHaveBeenCalled();
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("returns true without starting when the server is already healthy", async () => {
    mocked.config.opencode.startOnDemand = true;
    mocked.healthMock.mockResolvedValue(healthyResponse());

    const result = await ensureOpencodeServerRunning("prompt");

    expect(result).toBe(true);
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
    expect(mocked.notifyReadyMock).toHaveBeenCalledWith("on_demand_already_running_prompt");
  });

  it("starts the local server and notifies ready when it becomes healthy", async () => {
    mocked.config.opencode.startOnDemand = true;
    const childProcess = createChildProcess(321);
    mocked.startLocalOpencodeServerMock.mockReturnValue(childProcess);
    mocked.healthMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(healthyResponse());

    const promise = ensureOpencodeServerRunning("prompt");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalledWith({
      host: "localhost",
      port: 4096,
    });
    expect(childProcess.unref).toHaveBeenCalledTimes(1);
    expect(mocked.notifyReadyMock).toHaveBeenCalledWith("on_demand_prompt");
  });

  it("records server activity after a cold start so idle shutdown keeps the window", async () => {
    mocked.config.opencode.startOnDemand = true;
    const markActivity = vi.spyOn(opencodeServerActivity, "markActivity");
    mocked.healthMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(healthyResponse());

    const promise = ensureOpencodeServerRunning("prompt");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalledTimes(1);
    expect(markActivity).toHaveBeenCalled();

    markActivity.mockRestore();
  });

  it("returns false when the server does not become ready in time", async () => {
    mocked.config.opencode.startOnDemand = true;
    mocked.healthMock.mockRejectedValue(new Error("offline"));

    const promise = ensureOpencodeServerRunning("prompt");
    await vi.advanceTimersByTimeAsync(10_500);
    const result = await promise;

    expect(result).toBe(false);
    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifyReadyMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("did not become ready"),
    );
  });

  it("waits for an in-progress lifecycle operation before checking health", async () => {
    mocked.config.opencode.startOnDemand = true;
    mocked.healthMock.mockResolvedValue(healthyResponse());

    let releaseLock: () => void = () => undefined;
    const lockHeld = opencodeServerLifecycleLock.run(
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );

    let resolved = false;
    const promise = ensureOpencodeServerRunning("prompt").then((value) => {
      resolved = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(mocked.healthMock).not.toHaveBeenCalled();

    releaseLock();
    await lockHeld;
    const result = await promise;

    expect(result).toBe(true);
    expect(mocked.healthMock).toHaveBeenCalled();
  });

  it("notifies before starting the local server", async () => {
    mocked.config.opencode.startOnDemand = true;
    const notifier = vi.fn();
    setOnDemandStartNotifier(notifier);
    mocked.healthMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(healthyResponse());

    const promise = ensureOpencodeServerRunning("prompt");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(notifier).toHaveBeenCalledWith("prompt");
  });

  it("starts the server even when the notification fails", async () => {
    mocked.config.opencode.startOnDemand = true;
    setOnDemandStartNotifier(() => {
      throw new Error("telegram down");
    });
    mocked.healthMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(healthyResponse());

    const promise = ensureOpencodeServerRunning("prompt");
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe(true);
    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send on-demand start notification"),
      expect.any(Error),
    );
  });

  it("returns true without starting for remote OpenCode URLs", async () => {
    mocked.config.opencode.startOnDemand = true;
    mocked.config.opencode.apiUrl = "https://example.com";
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue(null);

    const result = await ensureOpencodeServerRunning("prompt");

    expect(result).toBe(true);
    expect(mocked.healthMock).not.toHaveBeenCalled();
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("returns true without starting in a container runtime", async () => {
    mocked.config.opencode.startOnDemand = true;
    vi.stubEnv("OPENCODE_TELEGRAM_CONTAINER", "1");

    const result = await ensureOpencodeServerRunning("prompt");

    expect(result).toBe(true);
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
  });
});
