import { drizzle } from "drizzle-orm/node-postgres";

export function createDatabase(pool) {
  return pool ? drizzle(pool) : null;
}
