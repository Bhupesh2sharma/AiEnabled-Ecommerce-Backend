# Ecommerce Backend

Node.js (CommonJS) + Express 5 + PostgreSQL 18 (`pg`), MVC structure.

## Commands

```bash
npm run dev                         # start with auto-reload (http://localhost:8080)
npm start                           # start
npm run migrate                     # apply pending migrations
npm run migrate:status              # list applied / pending migrations
npm run migrate:create <name>       # create src/db/migrations/<timestamp>_<name>.sql
```

Health check: `GET /api/health` (200 when Postgres is reachable, 503 otherwise).

Port is 8080. Do not use 5000: macOS AirPlay Receiver listens there and returns 403.

## Structure

```
src/
  server.js        connects to DB, starts HTTP server, graceful shutdown
  app.js           Express app, mounts routes under /api
  config/          env.js (env vars), db.js (pg Pool, query())
  routes/          URL -> controller; index.js combines all routers
  controllers/     request/response handling, calls models
  models/          SQL queries only (via config/db query())
  middlewares/     notFound, errorHandler
  db/migrations/   timestamped .sql migration files
scripts/migrate.js migration runner
docs/DATABASE.md   database schema documentation
plans/             feature plans (e.g. authentication-plan.md)
```

Env vars live in `.env` (loaded with `node --env-file`); see `.env.example`.
The DB password contains `#`, which must be URL-encoded as `%23` in `DATABASE_URL`.

## Database: read and maintain `docs/DATABASE.md`

- **Before writing any code that touches the database** (models, queries, migrations,
  controllers that read/write data), read `docs/DATABASE.md` to understand the tables,
  their groups, relationships and the rules enforced in application code.
- **Every migration that adds or changes a table must update `docs/DATABASE.md` in the
  same change**: the table group, the mermaid ER diagram, the relationships table, the
  table's column list, its "Referenced by" links, and any app-enforced rules.
- Follow the conventions listed in `docs/DATABASE.md` (UUIDv7 ids, TIMESTAMPTZ,
  `set_updated_at()` trigger, soft delete with partial unique indexes, ENUM types, E.164 phones).
- Enforce the "Rules (enforced in application code)" listed per table in the models/controllers.

## Migrations

- Create new files with `npm run migrate:create <name>`; never hand-pick timestamps.
- Never edit a migration that has already been applied. Write a new migration instead.
- Each file runs in a transaction; keep one logical change per file.
- Create referenced tables before the tables that point to them.

## Plans

Feature plans live in `plans/`. Before working on a feature that has a plan
(e.g. `plans/authentication-plan.md`), read it and follow its steps in order.
Mark a step ✅ in the plan when it is finished, and record any decision changes there.
