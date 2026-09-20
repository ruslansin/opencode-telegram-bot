import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  resolveLocalOpencodeTargetMock: vi.fn(),
  findServerPidMock: vi.fn(),
  killServerProcessMock: vi.fn(),
  releaseLocalStateMock: vi.fn(),
  isForegroundBusyMock: vi.fn(),
  interactionActiveMock: vi.fn(),
  promptQueueSizeMock: vi.fn(),
  clearRuntimeStateMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      autoRestartEnabled: false,
      idleShutdownSec: 0,
    },
  },
}));

vi.mock("../../src/config.js", () => ({
  config: mocked.config,
}));

vi.mock("../../src/opencode/process.js", () => ({
  resolveLocalOpencodeTarget: mocked.resolveLocalOpencodeTargetMock,
  findServerPid: mocked.findServerPidMock,
  killServerProcess: mocked.killServerProcessMock,
}));

vi.mock("../../src/app/services/release-local-state-service.js", () => ({
  releaseLocalStateAfterServerStop: mocked.releaseLocalStateMock,
}));

vi.mock("../../src/app/services/run-control-service.js", () => ({
  isForegroundBusy: mocked.isForegroundBusyMock,
}));

vi.mock("../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: {
    isActive: mocked.interactionActiveMock,
    clear: vi.fn(),
  },
}));

vi.mock("../../src/app/managers/prompt-queue-manager.js", () => ({
  promptQueue: {
    size: mocked.promptQueueSizeMock,
    __resetForTests: vi.fn(),
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

import { OpencodeIdleShutdownService } from "../../src/opencode/idle-shutdown.js";
import { defined } from "../helpers/defined.js";

describe("opencode/idle-shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    mocked.resolveLocalOpencodeTargetMock.mockReset();
    mocked.findServerPidMock.mockReset();
    mocked.killServerProcessMock.mockReset();
    mocked.releaseLocalStateMock.mockReset();
    mocked.isForegroundBusyMock.mockReset();
    mocked.interactionActiveMock.mockReset();
    mocked.promptQueueSizeMock.mockReset();
    mocked.clearRuntimeStateMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerInfoMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerErrorMock.mockReset();

    mocked.config.opencode.apiUrl = "http://localhost:4096";
    mocked.config.opencode.autoRestartEnabled = false;
    mocked.config.opencode.idleShutdownSec = 0;

    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "localhost", port: 4096 });
    mocked.findServerPidMock.mockResolvedValue(456);
    mocked.killServerProcessMock.mockResolvedValue(true);
    mocked.releaseLocalStateMock.mockResolvedValue(undefined);
    mocked.isForegroundBusyMock.mockReturnValue(false);
    mocked.interactionActiveMock.mockReturnValue(false);
    mocked.promptQueueSizeMock.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("does nothing when idle shutdown is disabled", () => {
    const service = new OpencodeIdleShutdownService();

    expect(service.start()).toBe(false);
    expect(mocked.resolveLocalOpencodeTargetMock).not.toHaveBeenCalled();
  });

  it("does nothing when auto-restart is enabled", () => {
    mocked.config.opencode.idleShutdownSec = 60;
    mocked.config.opencode.autoRestartEnabled = true;
    const service = new OpencodeIdleShutdownService();

    expect(service.start()).toBe(false);
    expect(mocked.resolveLocalOpencodeTargetMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
  });

  it("does nothing for remote OpenCode URLs", () => {
    mocked.config.opencode.idleShutdownSec = 60;
    mocked.config.opencode.apiUrl = "https://example.com";
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue(null);
    const service = new OpencodeIdleShutdownService();

    expect(service.start()).toBe(false);
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("OPENCODE_API_URL is not local"),
    );
  });

  it("does nothing in a container runtime", () => {
    mocked.config.opencode.idleShutdownSec = 60;
    vi.stubEnv("OPENCODE_TELEGRAM_CONTAINER", "1");
    const service = new OpencodeIdleShutdownService();

    expect(service.start()).toBe(false);
    expect(mocked.resolveLocalOpencodeTargetMock).not.toHaveBeenCalled();
  });

  it("stops the local server after the idle threshold", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    const service = new OpencodeIdleShutdownService();
    service.setClearRuntimeState(mocked.clearRuntimeStateMock);
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.findServerPidMock).toHaveBeenCalledWith(4096);
    expect(mocked.killServerProcessMock).toHaveBeenCalledWith(456, 5000);
    expect(mocked.releaseLocalStateMock).toHaveBeenCalledWith(
      mocked.clearRuntimeStateMock,
      "opencode_idle_shutdown",
    );

    service.stop();
  });

  it("does not stop before the idle threshold", async () => {
    mocked.config.opencode.idleShutdownSec = 60;
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mocked.findServerPidMock).not.toHaveBeenCalled();

    service.stop();
  });

  it("does not stop while a run is busy", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    mocked.isForegroundBusyMock.mockReturnValue(true);
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.findServerPidMock).not.toHaveBeenCalled();

    service.stop();
  });

  it("does not stop while an interaction is active", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    mocked.interactionActiveMock.mockReturnValue(true);
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.findServerPidMock).not.toHaveBeenCalled();

    service.stop();
  });

  it("does not stop while prompts are queued", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    mocked.promptQueueSizeMock.mockReturnValue(2);
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.findServerPidMock).not.toHaveBeenCalled();

    service.stop();
  });

  it("skips stopping when no local process is found", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    mocked.findServerPidMock.mockResolvedValue(null);
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.killServerProcessMock).not.toHaveBeenCalled();
    expect(mocked.releaseLocalStateMock).not.toHaveBeenCalled();

    service.stop();
  });

  it("keeps running when the process cannot be stopped", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    mocked.killServerProcessMock.mockResolvedValue(false);
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.releaseLocalStateMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop idle server"),
    );

    service.stop();
  });

  it("notifies the user before stopping the idle server", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    const notifyStopped = vi.fn();
    const service = new OpencodeIdleShutdownService();
    service.setNotifyStopped(notifyStopped);
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(notifyStopped).toHaveBeenCalledWith({ minutes: 1 });
    expect(defined(notifyStopped.mock.invocationCallOrder[0])).toBeLessThan(
      defined(mocked.killServerProcessMock.mock.invocationCallOrder[0]),
    );

    service.stop();
  });

  it("still stops the server when the notification fails", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    const service = new OpencodeIdleShutdownService();
    service.setNotifyStopped(() => {
      throw new Error("telegram down");
    });
    expect(service.start()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(mocked.killServerProcessMock).toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send idle shutdown notification"),
      expect.any(Error),
    );

    service.stop();
  });

  it("stops checking after stop() is called", async () => {
    mocked.config.opencode.idleShutdownSec = 1;
    const service = new OpencodeIdleShutdownService();
    expect(service.start()).toBe(true);
    service.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(mocked.findServerPidMock).not.toHaveBeenCalled();
  });
});
