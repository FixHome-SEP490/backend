# Contributing to FixHome

> Ngữ cảnh hiện hành của repo (luồng, hợp đồng, quyết định, việc đang dở) nằm ở [`docs/CONTEXT.md`](docs/CONTEXT.md); khi file này lệch với code hoặc với CONTEXT.md, CONTEXT.md và code là chuẩn.

## Git Convention

### Branch Strategy

```
main              # Production-ready code
dev               # Integration branch
feature/<name>    # New features (e.g., feature/auth-login)
fix/<name>        # Bug fixes (e.g., fix/booking-validation)
```

### Workflow

1. Create branch from `dev`
2. Implement changes and run the local gates (`npm run lint`, `npm test`, `npm run build`)
3. Create Pull Request to `dev`
4. Code review by at least 1 team member
5. Merge into `dev` only after approval and when the PR's CI run is green

### Commit Convention (Conventional Commits)

```
feat: add user registration endpoint
fix: correct booking date validation
refactor: extract base entity
docs: update API documentation
test: add auth service unit tests
chore: update dependencies
style: fix code formatting
```

Format: `<type>: <description>`

## Code Convention

### General

- Use **TypeScript** (not full strict mode: `tsconfig.json` sets `strictNullChecks` and
  `noImplicitAny` to `false`, so guard against `null`/`undefined` explicitly)
- Use **OxLint** for linting and **Prettier** for formatting
- Single quotes, trailing commas, semicolons
- Tab width: 2 spaces
- Maximum line length: 100 characters (soft limit)

### Naming Convention

| Type | Convention | Example |
|------|-----------|---------|
| File (Backend) | kebab-case | `users.controller.ts` |
| File (Vue Component) | PascalCase | `LoginPage.vue` |
| File (React Component) | PascalCase | `LoginScreen.tsx` |
| File (utility) | kebab-case / camelCase | `storage.ts` |
| Class | PascalCase | `UsersService` |
| Interface | PascalCase | `ApiResponse` |
| Enum | PascalCase | `Role` |
| Variable | camelCase | `currentUser` |
| Constant | UPPER_SNAKE_CASE | `JWT_SECRET` |
| Function | camelCase | `getUserById` |
| Database table | snake_case, plural | `users`, `service_orders` |
| Database column | snake_case | `full_name`, `created_at` |
| API endpoint | kebab-case, plural | `/api/v1/service-orders` |

### Backend (NestJS)

- One module per feature
- Services contain business logic
- Controllers handle HTTP only
- Use DTOs for request validation
- Use entities for database models
- Use enums for fixed value sets

### Web (Vue.js)

- Composition API with `<script setup>`
- Pinia stores for global state
- Composables for reusable logic
- PascalCase for components
- Lazy-load route components

### Mobile (React Native)

- Functional components with hooks
- Zustand for state management
- Expo SDK for native features
- Type-safe navigation with React Navigation

## API Convention

### RESTful Endpoints

```
GET    /api/v1/resources           # List (with pagination)
GET    /api/v1/resources/:id       # Get by ID
POST   /api/v1/resources           # Create
PATCH  /api/v1/resources/:id       # Partial update
DELETE /api/v1/resources/:id       # Delete
```

### Response Format

Every response is wrapped by the global `TransformInterceptor` (success) or
`HttpExceptionFilter` (error) in `src/common`.

**Success:**
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": { ... }
}
```

**Paginated:**
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "totalPages": 10
  }
}
```

**Error:**
```json
{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": ["email must be an email"]
  },
  "timestamp": "2026-01-01T00:00:00.000Z",
  "path": "/api/v1/auth/register"
}
```

`error.details` is optional (validation messages, or debug info for 5xx outside production).
Business errors carry their own `error.code` from `BusinessException`.

### HTTP Status Codes

| Code | Usage |
|------|-------|
| 200 | Success |
| 201 | Created |
| 400 | Validation error |
| 401 | Unauthorized |
| 403 | Forbidden (wrong role) |
| 404 | Not found |
| 409 | Conflict (duplicate) |
| 413 | Request payload too large |
| 500 | Internal server error |
| 503 | Service unavailable (e.g. dependency down) |

## Database Convention

- Primary keys: UUID v4
- Table names: snake_case, plural (`users`, `service_orders`)
- Column names: snake_case (`full_name`, `created_at`)
- All tables have: `id`, `created_at`, `updated_at`
- Foreign keys: `<entity>_id` format (`user_id`)
- Use migrations for schema changes
- `synchronize` is `false` in every environment; never turn it on

## Pull Request

### Template

```
## What
Brief description of changes.

## Why
Reason for the change.

## How
Implementation approach.

## Testing
How was this tested?

## Screenshots (if UI changes)
```
