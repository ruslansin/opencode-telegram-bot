import { config } from "../config.js";
import { isContainerRuntime } from "../runtime/container.js";
import { logger } from "../utils/logger.js";
import { resolveLocalOpencodeTarget, startLocalOpencodeServer } from "./process.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";
import { opencodeServerActivity } from "./server-activity.js";
import { opencodeServerLifecycleLock } from "./server-lifecycle-lock.js";
import {
  getOpencodeHealth,
  SERVER_READY_TIMEOUT_MS,
  waitForOpencodeServerReady,
} from "./server-health.js";

let onDemandStartNotifier: ((reason: string) => Promise<void> | void) | null = null;

export function setOnDemandStartNotifier(
  notifier: ((reason: string) => Promise<void> | void) | null,
): void {
  onDemandStartNotifier = notifier;
}

async function notifyOnDemandStart(reason: string): Promise<void> {
  if (!onDemandStartNotifier) {
    return;
  }

  try {
    await onDemandStartNotifier(reason);
  } catch (error) {
    logger.warn("[OpenCodeOnDemand] Failed to send on-demand start notification", error);
  }
}

/**
 * Ensures the local OpenCode server is running when on-demand startup is enabled.
 *
 * Returns true when the caller may proceed: either the server is reachable, the
 * server is managed elsewhere (remote URL / container), or the feature is off.
 * Returns false only when an on-demand start was attempted and failed.
 */
export async function ensureOpencodeServerRunning(reason: string): Promise<boolean> {
  if (!config.opencode.startOnDemand) {
    return true;
  }

  if (isContainerRuntime()) {
    return true;
  }

  const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
  if (!localTarget) {
    return true;
  }

  return opencodeServerLifecycleLock.run(async () => {
    const health = await getOpencodeHealth();
    if (health?.data?.healthy) {
      opencodeServerActivity.markActivity();
      await opencodeReadyLifecycle.notifyReady(`on_demand_already_running_${reason}`);
      return true;
    }

    logger.info(
      `[OpenCodeOnDemand] Starting local OpenCode server: reason=${reason}, port=${localTarget.port}`,
    );
    await notifyOnDemandStart(reason);

    const childProcess = startLocalOpencodeServer(localTarget);
    childProcess.once("error", (error) => {
      logger.error("[OpenCodeOnDemand] OpenCode server process failed to start", error);
    });

    const pid = childProcess.pid;
    childProcess.unref();

    const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);
    if (!ready) {
      logger.warn(
        `[OpenCodeOnDemand] OpenCode server did not become ready: pid=${pid ?? "unknown"}, port=${localTarget.port}, reason=${reason}`,
      );
      return false;
    }

    // The server was just started, so restart the idle window; otherwise the
    // idle shutdown timer could stop it right after the next tick.
    opencodeServerActivity.markActivity();

    logger.info(
      `[OpenCodeOnDemand] OpenCode server is ready: pid=${pid ?? "unknown"}, port=${localTarget.port}, reason=${reason}`,
    );
    await opencodeReadyLifecycle.notifyReady(`on_demand_${reason}`);
    return true;
  });
}
