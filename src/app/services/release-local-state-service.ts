import { attachManager } from "../managers/attach-manager.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { markAttachedSessionIdle } from "./attach-service.js";
import { clearPromptResponseMode } from "../../bot/handlers/prompt.js";
import { opencodeReadyLifecycle } from "../../opencode/ready-lifecycle.js";

/**
 * Releases all bot-side runtime state after the local OpenCode server has been
 * stopped, mirroring the cleanup performed by `/opencode_stop`.
 */
export async function releaseLocalStateAfterServerStop(
  clearRuntimeState: (reason: string) => void,
  reason: string,
): Promise<void> {
  const sessionIds = new Set<string>();

  for (const session of foregroundSessionState.getBusySessions()) {
    sessionIds.add(session.sessionId);
  }

  const attached = attachManager.getSnapshot();
  if (attached) {
    sessionIds.add(attached.sessionId);
  }

  clearRuntimeState(reason);
  foregroundSessionState.clearAll(reason);

  if (attached) {
    await markAttachedSessionIdle(attached.sessionId);
  }

  for (const sessionId of sessionIds) {
    clearPromptResponseMode(sessionId);
  }

  promptQueue.clear(reason);
  clearAllInteractionState(reason);
  opencodeReadyLifecycle.notifyUnavailable(reason);
}
