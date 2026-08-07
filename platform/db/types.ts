import type { Pool, PoolClient } from "pg";

// Repository functions accept either a Pool (autocommit, single query) or a
// PoolClient (inside an explicit transaction) — both expose the same query API.
export type Queryable = Pool | PoolClient;
