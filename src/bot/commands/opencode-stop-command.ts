import { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import {
  findServerPid,
  killServerProcess,
  resolveLocalOpencodeTarget,
} from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isContainerRuntime } from "../../runtime/container.js";
import { editBotText } from "../messages/telegram-text.js";
import { releaseLocalStateAfterServerStop } from "../../app/services/release-local-state-service.js";
import { opencodeServerLifecycleLock } from "../../opencode/server-lifecycle-lock.js";

export interface OpencodeStopCommandDeps {
  clearRuntimeState: (reason: string) => void;
}

const STOP_REASON = "opencode_stop";

/**
 * Command handler for /opencode-stop
 * Stops the OpenCode server process
 */
export async function opencodeStopCommand(
  ctx: CommandContext<Context>,
  deps: OpencodeStopCommandDeps,
) {
  try {
    if (isContainerRuntime()) {
      await ctx.reply(t("runtime.container.command_unavailable"));
      return;
    }

    const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (!localTarget) {
      await ctx.reply(t("opencode_stop.remote_configured"));
      return;
    }

    // Serialized with idle shutdown and on-demand start so a stop cannot race
    // with a start that is in progress.
    await opencodeServerLifecycleLock.run(async () => {
      const pid = await findServerPid(localTarget.port);
      if (!pid) {
        await ctx.reply(t("opencode_stop.not_running"));
        return;
      }

      const statusMessage = await ctx.reply(t("opencode_stop.stopping", { pid }));

      const stopped = await killServerProcess(pid, 5000);
      if (!stopped) {
        await editBotText({
          api: ctx.api,
          chatId: ctx.chat.id,
          messageId: statusMessage.message_id,
          text: t("opencode_stop.stop_error", { error: t("common.unknown_error") }),
        });
        return;
      }

      await releaseLocalStateAfterServerStop(deps.clearRuntimeState, STOP_REASON);

      await editBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        messageId: statusMessage.message_id,
        text: t("opencode_stop.success"),
      });

      logger.info(
        `[Bot] OpenCode server stopped successfully, PID=${pid}, port=${localTarget.port}`,
      );
    });
  } catch (err) {
    logger.error("[Bot] Error in /opencode-stop command:", err);
    await ctx.reply(t("opencode_stop.error"));
  }
}
