<h1 align="center">FixHome — Backend API</h1>

> Ngữ cảnh hiện hành của repo (luồng, hợp đồng, quyết định, việc đang dở) nằm ở [`docs/CONTEXT.md`](docs/CONTEXT.md); khi file này lệch với code hoặc với CONTEXT.md, CONTEXT.md và code là chuẩn.

<p align="center">
  <strong>NestJS Backend API cho nền tảng sửa chữa & bảo trì tại nhà FixHome</strong>
</p>

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | NestJS |
| Language | TypeScript |
| ORM | TypeORM |
| Database | Supabase PostgreSQL (shared, configured in `.env`) |
| File storage | Supabase Storage (KYC, private files), Cloudinary (media) |
| Auth | JWT + RBAC, Google OAuth |
| Payments | VNPay (customer payment), payOS (technician payouts) |
| Realtime | Socket.IO (`/chat`, voice call signalling) |
| Maps | MapTiler |
| Mail | SMTP (nodemailer) |
| AI | Self-hosted FixHome `ai-service` (Qwen2.5-VL + YOLO) via `AI_SERVICE_URL` |
| Testing | Vitest |

## Prerequisites

- **Node.js** version from `.nvmrc`
- **npm** >= 9
- **Docker** & **Docker Compose** (optional, only to run the backend in a container; see [docs/DOCKER.md](docs/DOCKER.md))

## Quick Start

There is no local PostgreSQL container. The backend connects to the shared Supabase
PostgreSQL configured in `.env`.

### 1. Configure environment

```bash
cp .env.example .env
```

Fill in the values (database, JWT secrets, `AI_SERVICE_URL`, storage, payment keys) from the team;
never commit `.env`.

### 2. Install & Run

```bash
npm ci
npm run start:dev
```

Or run the backend in Docker (backend only, same Supabase database from `.env`):

```bash
docker compose up -d
```

### 3. Verify

- API: http://localhost:3000/api/v1
- Swagger: http://localhost:3000/api/docs
- Health: http://localhost:3000/api/v1/health

```bash
curl http://localhost:3000/api/v1/health
```

### Quality Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e # requires a reachable PostgreSQL (CI uses a postgres service)
```

## Project Structure

```
├── src/
│   ├── app.module.ts          # Root module
│   ├── main.ts                # Entry point
│   ├── setup-app.ts           # Global prefix, pipes, filter, interceptors, Swagger
│   ├── modules/               # 29 implemented feature modules, e.g.
│   │   ├── auth/              # Authentication (JWT, Google OAuth)
│   │   ├── users/             # User management
│   │   ├── bookings/          # Booking + technician invitations
│   │   ├── service-orders/    # Service order & state machine
│   │   ├── quotations/        # Quotations
│   │   ├── part-requests/     # Part requests
│   │   ├── finance/           # Payments (VNPay)
│   │   ├── wallet/            # Top-up, payOS payouts, settlement
│   │   ├── technician-assignment/
│   │   ├── messaging/         # Socket.IO /chat, voice call signalling
│   │   ├── ai-diagnosis/      # Client of the FixHome ai-service
│   │   ├── support-cases/     # Support cases
│   │   ├── technician-verifications/ # KYC on Supabase Storage
│   │   ├── media/             # Media uploads (Cloudinary)
│   │   ├── geo/               # Geocoding (MapTiler)
│   │   ├── rbac/, audit-log/, system-config/, notifications/, reviews/, ...
│   │   └── health/            # Health check
│   ├── common/                # Guards, decorators, exception filter, interceptors
│   ├── config/                # Environment validation
│   ├── database/              # TypeORM config, data source, migrations, seeds
│   └── shared/                # Shared utilities, DTOs, enums
├── test/                      # E2E tests
├── docker-compose.yml         # Backend container (uses Supabase from .env)
├── package.json
└── tsconfig.json
```

## Environment Variables

See [.env.example](.env.example) for all required variables.

## Related Repositories

- [Web](https://github.com/FixHome-SEP490/web)
- [Mobile](https://github.com/FixHome-SEP490/mobile)
- [AI Service](https://github.com/FixHome-SEP490/ai-service)
- [Project Documentation](https://github.com/FixHome-SEP490/docs)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development conventions.

## Engineering Governance

Before any change, read [AGENTS.md](AGENTS.md) and the repository-specific
[AI Technical Guide](docs/AI-TECHNICAL-GUIDE.md). Pull requests are gated by this repository's own
GitHub Actions workflow for lint, type check, runtime dependency audit, unit tests, build, and
PostgreSQL-backed E2E tests.
