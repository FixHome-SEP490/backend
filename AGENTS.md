# FixHome Backend — Agent Instructions

This repository is an independent Git repository. Preserve its NestJS modular architecture and do
not move code to another FixHome repository.

## Mandatory pre-implementation gate

Before doing any task:

1. Read `docs/AI-TECHNICAL-GUIDE.md` completely.
2. Inspect the existing project structure and the affected feature module.
3. Understand the current controller → service → repository/entity architecture.
4. Identify existing TypeScript, NestJS, DTO, error, and test conventions.
5. Check `package.json`, configuration, and relevant dependencies.
6. Search for an existing implementation before creating code.
7. Do not modify unrelated files.
8. Do not restructure the project unless explicitly requested.
9. Preserve API contracts, database contracts, RBAC, and business rules.
10. After implementation, execute the complete review process in the technical guide.

If the technical guide has not been read, implementation must not begin.

## Repository rules

- NestJS Backend is the authoritative business layer; clients must not replace its validation.
- Protect private routes with JWT plus RBAC and verify resource ownership to prevent IDOR.
- Route every Service Order status change through `ServiceOrderStateMachine`.
- Use DTO validation and the existing global response/error behavior.
- Use TypeORM migrations for schema changes. Never enable synchronization outside development.
- Coordinate API, enum, AI schema, environment, or database contract changes with every consumer
  and `Docs-FixHome`.
- Never commit `.env`, credentials, access tokens, customer data, or provider keys.

## Keep Docker working

This repository ships a `docker-compose.yml` that other developers run daily. It reads the whole
`.env` through `env_file`, so a new environment variable needs no compose change. Everything else
does:

- Adding or removing a dependency changes the image. Say so in the handover and tell the team to
  run `docker compose up -d --build`; the mounted volumes only carry `src` and `test`.
- Changing the listening port means updating `ports`, the `HEALTHCHECK` in `docker-compose.yml`,
  and `CORS_ORIGIN`.
- A service the backend calls that runs on the developer's machine rather than in Docker must be
  reached through `host.docker.internal`, never `localhost`.
- Do not reintroduce a local PostgreSQL service. The database is the shared Supabase instance
  declared in `.env`; a local one comes up with no tables because `synchronize` is off and no
  migration step runs.

After a change that touches the image or the runtime contract, verify with
`docker compose up -d --build` and a request against `/health` before handing over. `docs/DOCKER.md`
explains the setup for people new to Docker — keep it true when you change the setup.

## Required verification

Run the gates supported by the change: `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, and `npm run test:e2e` when PostgreSQL-backed behavior is affected. Review
`git diff` and report unexecuted checks as `NOT VERIFIED`; never convert them to `PASS`.
