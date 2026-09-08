import { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { opencodeReadyLifecycle } from "../../opencode/ready-lifecycle.js";
import {
  getOpencodeHealth,
  SERVER_READY_TIMEOUT_MS,
  waitForOpencodeServerReady,
} from "../../opencode/server-health.js";
import { opencodeServerLifecycleLock } from "../../opencode/server-lifecycle-lock.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isContainerRuntime } from "../../runtime/container.js";
import { editBotText } from "../messages/telegram-text.js";

/**
 * Command handler for /opencode-start
 * Starts the OpenCode server process
 */
export async function opencodeStartCommand(ctx: CommandContext<Context>) {
  try {
    if (isContainerRuntime()) {
      await ctx.reply(t("runtime.container.command_unavailable"));
      return;
    }

    const localTarget = resolveLocalOpencodeTarget(config.opencode.apiUrl);
    if (!localTarget) {
      await ctx.reply(t("opencode_start.remote_configured"));
      return;
    }

    // Serialized with idle shutdown and on-demand start so the server cannot be
    // killed between the health check and the actual start.
    await opencodeServerLifecycleLock.run(async () => {
      // Check if server is already accessible.
      const health = await getOpencodeHealth();
      const data = health?.data;

      if (data?.healthy) {
        await ctx.reply(
          t("opencode_start.already_running", { version: data.version || t("common.unknown") }),
        );
        await opencodeReadyLifecycle.notifyReady("opencode_start_already_running");
        return;
      }

      const statusMessage = await ctx.reply(t("opencode_start.starting"));

      const childProcess = startLocalOpencodeServer(localTarget);

      childProcess.once("error", (error) => {
        logger.error("[Bot] OpenCode server process failed to start", error);
      });

      const pid = childProcess.pid;
      if (!pid) {
        await editBotText({
          api: ctx.api,
          chatId: ctx.chat.id,
          messageId: statusMessage.message_id,
          text: t("opencode_start.start_error", { error: t("common.unknown_error") }),
        });
        return;
      }

      childProcess.unref();

      logger.info("[Bot] Waiting for OpenCode server to become ready...");
      const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);

      if (!ready) {
        await editBotText({
          api: ctx.api,
          chatId: ctx.chat.id,
          messageId: statusMessage.message_id,
          text: t("opencode_start.started_not_ready", {
            pid,
          }),
        });
        return;
      }

      const finalHealth = (await getOpencodeHealth())?.data;
      await editBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        messageId: statusMessage.message_id,
        text: t("opencode_start.success", {
          pid,
          version: finalHealth?.version || t("common.unknown"),
        }),
      });

      logger.info(
        `[Bot] OpenCode server started successfully, PID=${pid}, port=${localTarget.port}`,
      );
      await opencodeReadyLifecycle.notifyReady("opencode_start_success");
    });
  } catch (err) {
    logger.error("[Bot] Error in /opencode-start command:", err);
    await ctx.reply(t("opencode_start.error"));
  }
}
