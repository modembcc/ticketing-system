import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";

describe("health endpoints", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
    app = buildApp({ pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end().catch(() => {
      // already ended by the "connection gone" test
    });
    await container.stop();
  });

  it("reports live without touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports ready once migrations have run against a real Postgres", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const { rows } = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r: { version: string }) => r.version)).toContain("0001_init.sql");
  });

  it("reports unavailable once the database connection is gone", async () => {
    await pool.end();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable" });
  });
});
