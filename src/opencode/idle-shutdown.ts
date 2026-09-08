import { config } from "../config.js";
import { isContainerRuntime } from "../runtime/container.js";
import { logger } from "../utils/logger.js";
import { isForegroundBusy } from "../app/services/run-control-service.js";
import { interactionManager } from "../app/managers/interaction-manager.js";
import { promptQueue } from "../app/managers/prompt-queue-manager.js";
import { releaseLocalStateAfterServerStop } from "../app/services/release-local-state-service.js";
import { opencodeServerActivity } from "./server-activity.js";
import { opencodeServerLifecycleLock } from "./server-lifecycle-lock.js";
import {
  findServerPid,
  killServerProcess,
  resolveLocalOpencodeTarget,
  type LocalOpencodeTarget,
} from "./process.js";

const MIN_CHECK_INTERVAL_MS = 1000;
const MAX_CHECK_INTERVAL_MS = 30_000;
const STOP_TIMEOUT_MS = 5000;
const IDLE_REASON = "opencode_idle_shutdown";

function resolveCheckIntervalMs(idleShutdownSec: number): number {
  return Math.min(Math.max(idleShutdownSec * 1000, MIN_CHECK_INTERVAL_MS), MAX_CHECK_INTERVAL_MS);
}

export interface IdleShutdownNotice {
  minutes: number;
}

/**
 * Stops the local OpenCode server after it has been idle for the configured
 * amount of time. Idle means no active run, pending interaction, or queued
 * prompt. The server is started again on demand by `ensureOpencodeServerRunning`.
 */
export class OpencodeIdleShutdownService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localTarget: LocalOpencodeTarget | null = null;
  private started = false;
  private checkInProgress = false;
  private clearRuntimeState: (reason: string) => void = () => {};
  private notifyStopped: (notice: IdleShutdownNotice) => Promise<void> | void = () => {};

  setClearRuntimeState(clearRuntimeState: (reason: string) => void): void {
    this.clearRuntimeState = clearRuntimeState;
  }

  setNotifyStopped(notifyStopped: (notice: IdleShutdownNotice) => Promise<void> | void): void {
    this.notifyStopped = notifyStopped;
  }

  start(): boolean {
    if (this.started) {
      return false;
    }

    const idleShutdownSec = config.opencode.idleShutdownSec;
    if (!idleShutdownSec || idleShutdownSec <= 0) {
      return false;
    }

    if (config.opencode.autoRestartEnabled) {
      logger.warn(
        "[OpenCodeIdleShutdown] Disabled: OPENCODE_AUTO_RESTART_ENABLED is enabled. " +
          "Idle shutdown and auto-restart are mutually exclusive.",
      );
      return false;
    }

    if (isContainerRuntime()) {
      logger.warn(
        "[OpenCodeIdleShutdown] Disabled: container runtime does not manage a local server process.",
      );
      return false;
    }

    const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (!localTarget) {
      logger.warn(
        `[OpenCodeIdleShutdown] Disabled because OPENCODE_API_URL is not local: ${config.opencode.apiUrl}`,
      );
      return false;
    }

    this.started = true;
    this.localTarget = localTarget;
    opencodeServerActivity.markActivity();

    const intervalMs = resolveCheckIntervalMs(idleShutdownSec);
    this.timer = setInterval(() => {
      void this.checkIdle();
    }, intervalMs);
    this.timer.unref?.();

    logger.info(
      `[OpenCodeIdleShutdown] Enabled: port=${localTarget.port}, idleShutdownSec=${idleShutdownSec}, checkIntervalMs=${intervalMs}`,
    );
    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.started = false;
    this.localTarget = null;
    this.checkInProgress = false;
  }

  private isServerInUse(): boolean {
    return isForegroundBusy() || interactionManager.isActive() || promptQueue.size() > 0;
  }

  private async checkIdle(): Promise<void> {
    if (!this.started || !this.localTarget || this.checkInProgress) {
      return;
    }

    if (this.isServerInUse()) {
      opencodeServerActivity.markActivity();
      return;
    }

    if (!this.hasBeenIdleLongEnough()) {
      return;
    }

    this.checkInProgress = true;
    const port = this.localTarget.port;

    try {
      // Re-check under the lifecycle lock: an on-demand start may have begun
      // between the cheap pre-check above and acquiring the lock.
      await opencodeServerLifecycleLock.run(async () => {
        if (this.isServerInUse()) {
          opencodeServerActivity.markActivity();
          return;
        }

        const idleMs = Date.now() - opencodeServerActivity.getLastActivityAt();
        if (idleMs < config.opencode.idleShutdownSec * 1000) {
          return;
        }

        const pid = await findServerPid(port);
        if (!pid) {
          logger.debug("[OpenCodeIdleShutdown] No local server process found; nothing to stop");
          opencodeServerActivity.markActivity();
          return;
        }

        logger.info(
          `[OpenCodeIdleShutdown] Stopping idle OpenCode server: pid=${pid}, port=${port}, idleMs=${idleMs}`,
        );

        await this.notifyIdleStop(idleMs);

        const stopped = await killServerProcess(pid, STOP_TIMEOUT_MS);
        if (!stopped) {
          logger.warn(
            `[OpenCodeIdleShutdown] Failed to stop idle server: pid=${pid}, port=${port}`,
          );
          return;
        }

        await releaseLocalStateAfterServerStop(this.clearRuntimeState, IDLE_REASON);
        logger.info(
          `[OpenCodeIdleShutdown] Stopped idle OpenCode server: pid=${pid}, port=${port}`,
        );
        opencodeServerActivity.markActivity();
      });
    } catch (error) {
      logger.error("[OpenCodeIdleShutdown] Failed to stop idle OpenCode server", error);
    } finally {
      this.checkInProgress = false;
    }
  }

  private hasBeenIdleLongEnough(): boolean {
    return (
      Date.now() - opencodeServerActivity.getLastActivityAt() >=
      config.opencode.idleShutdownSec * 1000
    );
  }

  private async notifyIdleStop(idleMs: number): Promise<void> {
    const minutes = Math.max(1, Math.round(idleMs / 60_000));
    try {
      await this.notifyStopped({ minutes });
    } catch (error) {
      logger.warn("[OpenCodeIdleShutdown] Failed to send idle shutdown notification", error);
    }
  }

  __resetForTests(): void {
    this.stop();
  }
}

export const opencodeIdleShutdownService = new OpencodeIdleShutdownService();
