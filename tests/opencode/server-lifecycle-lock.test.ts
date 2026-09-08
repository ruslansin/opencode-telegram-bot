import { describe, expect, it } from "vitest";
import { opencodeServerLifecycleLock } from "../../src/opencode/server-lifecycle-lock.js";

describe("opencode/server-lifecycle-lock", () => {
  it("runs tasks one at a time", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;

    const first = opencodeServerLifecycleLock.run(async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });

    const second = opencodeServerLifecycleLock.run(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("releases the lock when a task throws", async () => {
    await expect(
      opencodeServerLifecycleLock.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(opencodeServerLifecycleLock.run(async () => "ok")).resolves.toBe("ok");
  });
});
