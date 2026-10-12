import { createInterface } from "node:readline/promises";
import { stdin, stdout, env, exit } from "node:process";
import pg from "pg";
import { createPasswordService } from "../auth/passwords.js";
import { encrypt, hmac, normalizePhone, normalizeUsername } from "../auth/crypto.js";
import { uuidv7 } from "../ids.js";
import { seedRbac } from "../../../../db/seeds/rbac.mjs";
import { seedRegions } from "../../../../db/seeds/regions.mjs";

if (!stdin.isTTY || !stdout.isTTY) throw new Error("admin:bootstrap must run in an interactive TTY");
if (!env.DATABASE_URL || !env.AUTH_TOKEN_HMAC_KEY || !env.PHONE_ENCRYPTION_KEY_BASE64) throw new Error("DATABASE_URL and authentication keys are required");
const encryptionKey = Buffer.from(env.PHONE_ENCRYPTION_KEY_BASE64, "base64");
if (encryptionKey.length !== 32) throw new Error("PHONE_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
const ask = createInterface({ input: stdin, output: stdout, terminal: true });
const askHidden = (label) => new Promise((resolve) => {
  stdout.write(label);
  let value = "";
  stdin.setRawMode(true);
  const onData = (chunk) => {
    const character = chunk.toString("utf8");
    if (character === "\r" || character === "\n") { stdin.off("data", onData); stdin.setRawMode(false); stdout.write("\n"); resolve(value); return; }
    if (character === "\u0003") { stdin.off("data", onData); stdin.setRawMode(false); ask.close(); exit(130); }
    if (character === "\u007f") { value = value.slice(0, -1); return; }
    value += character;
  };
  stdin.on("data", onData);
});
try {
  const username = (await ask.question("管理员用户名: ")).trim();
  const displayName = (await ask.question("显示名称: ")).trim();
  const phone = (await ask.question("手机号: ")).trim();
  const password = await askHidden("密码: ");
  const confirmation = await askHidden("再次输入密码: ");
  if (!username || !displayName || !/^1\d{10}$/.test(phone) || password.length < 10 || password !== confirmation) throw new Error("输入无效或两次密码不一致");
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'super_admin' AND ur.revoked_at IS NULL LIMIT 1`);
    if (exists.rows[0]) throw new Error("首个超级管理员已经存在；请通过正常管理流程创建账号");
    await seedRbac(client);
    // 生产不跑 db:seed（见 db/seeds/README.md），regions 基础数据在此幂等补种（ON CONFLICT (code)），
    // 否则 stores.region_id NOT NULL 会让建店被空 regions 表阻断。
    await seedRegions(client);
    const role = await client.query("SELECT id FROM roles WHERE code = 'super_admin'");
    const passwordHash = await createPasswordService().hash(password);
    const id = uuidv7();
    const normalizedPhone = normalizePhone(phone);
    await client.query(`INSERT INTO users (id,username_display,username_normalized,display_name,phone_ciphertext,phone_lookup_hmac,phone_verified_at,password_hash,status)
      VALUES ($1,$2,$3,$4,$5,$6,now(),$7,'approved_active')`, [id, username, normalizeUsername(username), displayName, encrypt(encryptionKey, normalizedPhone), hmac(env.AUTH_TOKEN_HMAC_KEY, normalizedPhone), passwordHash]);
    await client.query("INSERT INTO user_roles (id,user_id,role_id) VALUES ($1,$2,$3)", [uuidv7(), id, role.rows[0].id]);
    await client.query("INSERT INTO user_data_scopes (id,user_id,scope_type) VALUES ($1,$2,'all')", [uuidv7(), id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await pool.end(); }
  stdout.write("已幂等补种 RBAC 与 regions 基础数据。\n首个超级管理员已创建。\n");
} finally { ask.close(); }
exit(0);
