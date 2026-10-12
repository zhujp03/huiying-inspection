import { hmac } from "./crypto.js";

export async function consumeRateLimit(pool, { scope, key, secret, limit, windowSeconds }) {
  const windowStartedAt = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const expiresAt = new Date(windowStartedAt.getTime() + windowSeconds * 1000);
  const keyHmac = hmac(secret, key);
  const result = await pool.query(`INSERT INTO rate_limit_buckets (scope,key_hmac,window_started_at,count,expires_at)
    VALUES ($1,$2,$3,1,$4)
    ON CONFLICT (scope,key_hmac,window_started_at) DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count`, [scope, keyHmac, windowStartedAt, expiresAt]);
  return result.rows[0]?.count <= limit ? result.rows[0].count : null;
}
