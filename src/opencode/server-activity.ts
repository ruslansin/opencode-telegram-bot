/**
 * Tracks the last time the local OpenCode server was used (a prompt was
 * dispatched). Read by the idle shutdown service. Kept as a leaf module so
 * both the bot layer and the OpenCode layer can use it without import cycles.
 */
class OpencodeServerActivity {
  private lastActivityAt = Date.now();

  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  getLastActivityAt(): number {
    return this.lastActivityAt;
  }

  __resetForTests(): void {
    this.lastActivityAt = Date.now();
  }
}

export const opencodeServerActivity = new OpencodeServerActivity();
