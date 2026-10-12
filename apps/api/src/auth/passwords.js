import argon2 from "argon2";
import { BoundedSemaphore } from "./limiter.js";

const options = Object.freeze({ type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 });
export function createPasswordService({ maxConcurrency = 2, maxQueue = 8 } = {}) {
  const semaphore = new BoundedSemaphore({ maxConcurrency, maxQueue });
  return Object.freeze({
    hash: (password) => semaphore.run(() => argon2.hash(password, options)),
    verify: (hash, password) => semaphore.run(() => argon2.verify(hash, password)),
  });
}
