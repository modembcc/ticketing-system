import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "../../../platform/migrate/run.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await runMigrations(connectionString);

const pool = new Pool({ connectionString });
const app = buildApp({ pool });

app.addHook("onClose", async () => {
  await pool.end();
});

await app.listen({ port, host });
