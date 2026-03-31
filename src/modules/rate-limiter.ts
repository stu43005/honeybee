class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private maxConcurrent: number = 1,
    private intervalMs: number = 1000
  ) {}

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.tryNext();
    });
  }

  private tryNext() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const resolve = this.queue.shift()!;
    resolve();
    setTimeout(() => {
      this.running--;
      this.tryNext();
    }, this.intervalMs);
  }
}

export const youtubeRateLimiter = new RateLimiter(1, 1000);
