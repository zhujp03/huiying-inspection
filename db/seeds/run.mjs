import pg from "pg";
import { seedRbac } from "./rbac.mjs";
import { seedRegions } from "./regions.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for seeds");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try { await seedRbac(pool); await seedRegions(pool); } finally { await pool.end(); }
