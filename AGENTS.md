# FixHome Backend — Agent Instructions

Before changing code, read the canonical project documentation:

1. [Project Documentation](https://github.com/FixHome-SEP490/Docs-FixHome/blob/main/PROJECT_DOCUMENTATION.md)
2. [AI Development Workflow](https://github.com/FixHome-SEP490/Docs-FixHome/blob/main/AI_DEVELOPMENT_WORKFLOW.md)
3. [Current Tasks](https://github.com/FixHome-SEP490/Docs-FixHome/blob/main/CURRENT_TASKS.md)

## Backend Rules

- NestJS is the authoritative business layer.
- Protect private endpoints with JWT and RBAC guards.
- Route Service Order transitions through `ServiceOrderStateMachine`.
- Use TypeORM migrations for schema changes; never rely on production synchronization.
- Coordinate every API contract change with Frontend, Mobile, AI, and Docs repositories.
- Run `npm run lint`, `npm test`, and `npm run build` before reporting completion.
