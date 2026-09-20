import { logger } from "../utils/logger.js";
import { opencodeClient } from "./client.js";

export const SERVER_READY_TIMEOUT_MS = 10_000;
export const SERVER_READY_POLL_INTERVAL_MS = 500;
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

const HEALTH_CHECK_TIMED_OUT = Symbol("health-check-timed-out");

type HealthCheckResult = Awaited<ReturnType<typeof opencodeClient.global.health>>;

async function healthWithTimeout(
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthCheckResult | typeof HEALTH_CHECK_TIMED_OUT> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      opencodeClient.global.health({ signal: controller.signal }),
      new Promise<typeof HEALTH_CHECK_TIMED_OUT>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(HEALTH_CHECK_TIMED_OUT);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/**
 * Returns the OpenCode health response, or null when the server is unreachable
 * or the health check times out.
 */
export async function getOpencodeHealth(
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthCheckResult | null> {
  try {
    const result = await healthWithTimeout(timeoutMs);
    if (result === HEALTH_CHECK_TIMED_OUT) {
      logger.warn(`[OpenCodeHealth] Health check timed out after ${timeoutMs}ms`);
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Wait for the OpenCode server to become ready by polling the health endpoint.
 *
 * @param maxWaitMs Maximum time to wait in milliseconds
 * @returns true if the server became ready, false on timeout
 */
export async function waitForOpencodeServerReady(
  maxWaitMs: number = SERVER_READY_TIMEOUT_MS,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const health = await getOpencodeHealth();
    if (health?.data?.healthy) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, SERVER_READY_POLL_INTERVAL_MS));
  }

  return false;
}
