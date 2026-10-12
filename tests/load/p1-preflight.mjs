import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateP1Plan } from "./p1-plan.mjs";

const planPath = process.env.P1_PLAN_PATH;
if (!planPath) throw new Error("P1_PLAN_PATH must point to an authorized non-production P1 plan outside the repository");
const plan = JSON.parse(await readFile(resolve(planPath), "utf8"));
const summary = validateP1Plan(plan);
console.log(JSON.stringify({ status: "ready", ...summary }));
