import { describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  flushPendingPrompt: vi.fn(),
  opencodeStopCommand: vi.fn(),
  ensureOpencodeServerRunning: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/message-merger.js", () => ({
  flushPendingPrompt: mocked.flushPendingPrompt,
  __resetMessageMergerForTests: vi.fn(),
}));

vi.mock("../../../src/bot/commands/opencode-stop-command.js", () => ({
  opencodeStopCommand: mocked.opencodeStopCommand,
}));

vi.mock("../../../src/opencode/on-demand-start.js", () => ({
  ensureOpencodeServerRunning: mocked.ensureOpencodeServerRunning,
}));

import {
  ensureCommandsInitialized,
  registerCommandRouter,
} from "../../../src/bot/routers/command-router.js";
import { BOT_COMMANDS } from "../../../src/bot/commands/definitions.js";
import { config } from "../../../src/config.js";
import { t } from "../../../src/i18n/index.js";

describe("bot/routers/command-router", () => {
  it("registers bot slash command handlers", () => {
    const bot = { command: vi.fn(), use: vi.fn() };

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });

    expect(bot.command.mock.calls.map(([command]) => command)).toEqual([
      "start",
      "help",
      "status",
      "settings",
      "opencode_start",
      "opencode_stop",
      "projects",
      "worktree",
      "open",
      "ls",
      "sessions",
      "messages",
      "new",
      "abort",
      "detach",
      "task",
      "tasklist",
      "rename",
      "commands",
      "skills",
      "mcps",
    ]);
  });

  it("flushes a pending prompt before routing a command", async () => {
    const bot = { command: vi.fn(), use: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[0]?.[0]);
    const ctx = { chat: { id: 123 }, message: { text: "/new" } } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.flushPendingPrompt).toHaveBeenCalledWith(123);
    expect(next).toHaveBeenCalledOnce();
  });

  it("starts OpenCode on demand before a server-dependent command", async () => {
    mocked.ensureOpencodeServerRunning.mockReset();
    mocked.ensureOpencodeServerRunning.mockResolvedValue(true);
    const bot = { command: vi.fn(), use: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[1]?.[0]);
    const ctx = { chat: { id: 123 }, message: { text: "/sessions" } } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.ensureOpencodeServerRunning).toHaveBeenCalledWith("command_sessions");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not start OpenCode for server-independent commands", async () => {
    mocked.ensureOpencodeServerRunning.mockReset();
    const bot = { command: vi.fn(), use: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[1]?.[0]);
    const ctx = { chat: { id: 123 }, message: { text: "/help" } } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.ensureOpencodeServerRunning).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("replies with an error when on-demand start fails", async () => {
    mocked.ensureOpencodeServerRunning.mockReset();
    mocked.ensureOpencodeServerRunning.mockResolvedValue(false);
    const bot = { command: vi.fn(), use: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[1]?.[0]);
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      chat: { id: 123 },
      message: { text: "/new" },
      reply,
    } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.ensureOpencodeServerRunning).toHaveBeenCalledWith("command_new");
    expect(reply).toHaveBeenCalledWith(t("opencode_start.error"));
    expect(next).not.toHaveBeenCalled();
  });

  it("passes clearRuntimeState to the opencode_stop handler", async () => {
    const bot = { command: vi.fn(), use: vi.fn() };
    const clearRuntimeState = vi.fn();
    mocked.opencodeStopCommand.mockReset();
    mocked.opencodeStopCommand.mockResolvedValue(undefined);

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState,
    });

    const stopRegistration = bot.command.mock.calls.find(([command]) => command === "opencode_stop");
    expect(stopRegistration).toBeDefined();

    const ctx = { chat: { id: 123 } } as unknown as Context;
    await stopRegistration?.[1](ctx);

    expect(mocked.opencodeStopCommand).toHaveBeenCalledWith(ctx, { clearRuntimeState });
  });

  it("initializes commands for the authorized chat", async () => {
    const next: NextFunction = vi.fn();
    const ctx = {
      from: { id: config.telegram.allowedUserId },
      chat: { id: 123 },
      api: { setMyCommands: vi.fn() },
    } as unknown as Context;

    await ensureCommandsInitialized(ctx, next);

    expect(ctx.api.setMyCommands).toHaveBeenCalledWith(BOT_COMMANDS, {
      scope: { type: "chat", chat_id: 123 },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
