export class BoundedSemaphore {
  #active = 0;
  #waiters = [];
  constructor({ maxConcurrency = 2, maxQueue = 8 } = {}) { this.maxConcurrency = maxConcurrency; this.maxQueue = maxQueue; }
  async run(work) {
    if (this.#active >= this.maxConcurrency && this.#waiters.length >= this.maxQueue) {
      const error = new Error("Authentication capacity is busy");
      error.code = "AUTH_BUSY";
      throw error;
    }
    await new Promise((resolve) => {
      if (this.#active < this.maxConcurrency) { this.#active += 1; resolve(); } else this.#waiters.push(resolve);
    });
    try { return await work(); } finally {
      const next = this.#waiters.shift();
      if (next) next(); else this.#active -= 1;
    }
  }
}
