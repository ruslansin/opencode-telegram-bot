/**
 * Serializes local OpenCode server lifecycle operations (idle shutdown and
 * on-demand start). Without it a request could observe a healthy server, then
 * have the server killed by the idle timer before the request is dispatched.
 *
 * Leaf module: safe to import from both the bot and OpenCode layers.
 */
class OpencodeServerLifecycleLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  __resetForTests(): void {
    this.tail = Promise.resolve();
  }
}

export const opencodeServerLifecycleLock = new OpencodeServerLifecycleLock();
