import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../../../platform/migrate/run.js";

describe("catalog + inventory: events", () => {
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
    await pool.end();
    await container.stop();
  });

  function eventPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: "Rocket Launch",
      venue: "Cape Canaveral",
      startsAt: "2026-02-01T00:00:00.000Z",
      saleStartsAt: "2026-01-01T00:00:00.000Z",
      saleEndsAt: "2026-01-08T00:00:00.000Z",
      capacity: 10,
      ...overrides,
    };
  }

  it("creates an event and generates one seat row per capacity slot, all AVAILABLE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({ capacity: 25 }),
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.capacity).toBe(25);
    expect(body.availableSeats).toBe(25);

    const { rows } = await pool.query(
      "SELECT status, count(*)::int AS count FROM inventory.seats WHERE event_id = $1 GROUP BY status",
      [body.id],
    );
    expect(rows).toEqual([{ status: "AVAILABLE", count: 25 }]);

    const { rows: totalRows } = await pool.query(
      "SELECT count(*)::int AS count FROM inventory.seats WHERE event_id = $1",
      [body.id],
    );
    expect(totalRows[0].count).toBe(25);
  });

  it("rejects creation with capacity <= 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({ capacity: 0 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/capacity/i);
  });

  it("rejects creation when saleStartsAt is not before saleEndsAt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({
        saleStartsAt: "2026-01-08T00:00:00.000Z",
        saleEndsAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/saleStartsAt/);
  });

  it("does not create seats when validation fails", async () => {
    const before = await pool.query("SELECT count(*)::int AS count FROM inventory.seats");

    await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({ capacity: -5 }),
    });

    const after = await pool.query("SELECT count(*)::int AS count FROM inventory.seats");
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("lists events for both admin and customer surfaces", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({ name: "Listing Check Event", capacity: 3 }),
    });
    const eventId = created.json().id;

    const adminList = await app.inject({ method: "GET", url: "/admin/events" });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().some((e: { id: string }) => e.id === eventId)).toBe(true);

    const customerList = await app.inject({ method: "GET", url: "/events" });
    expect(customerList.statusCode).toBe(200);
    const found = customerList.json().find((e: { id: string }) => e.id === eventId);
    expect(found).toBeDefined();
    expect(found.availableSeats).toBe(3);
  });

  it("fetches a single event by id with 404 for unknown id and 400 for a malformed id", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/events",
      payload: eventPayload({ name: "Get By Id Event" }),
    });
    const eventId = created.json().id;

    const found = await app.inject({ method: "GET", url: `/admin/events/${eventId}` });
    expect(found.statusCode).toBe(200);
    expect(found.json().id).toBe(eventId);

    const missing = await app.inject({
      method: "GET",
      url: "/admin/events/00000000-0000-0000-0000-000000000000",
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({ method: "GET", url: "/admin/events/not-a-uuid" });
    expect(malformed.statusCode).toBe(400);
  });
});
