# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `curl -f http://localhost:9000/minio/health/live` — expect HTTP 200
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — S3-compatible object storage, API port `9000`, console port `9001`
- `redis` — Redis 7, port `6379`, backs the `video-processing` BullMQ queue
- `video-worker` — consumes the `video-processing` queue (FFmpeg metadata/thumbnail extraction), no exposed port

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Video worker with hot-reload (compiles to dist-worker/)
npm run start:worker                     # Run the compiled worker build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting

npm run openapi:export                   # Regenerate openapi.json from the controllers
```

### OpenAPI contract — regenerate after every controller change

`openapi.json` is a committed artifact, not a build output. Whenever a controller, DTO or `@Api*` decorator changes, regenerate and re-sync it in the same change:

```bash
docker compose exec nestjs-api npm run openapi:export   # in nestjs-project/
bash scripts/sync-openapi.sh                            # from the repo root, on the host
```

The second command copies the spec to `next-frontend/openapi.json`, which the frontend's codegen consumes. Both steps are enforced by `.github/workflows/openapi-freshness.yml`: the `backend-spec` job re-runs the export against a PostgreSQL service container and fails if `nestjs-project/openapi.json` differs, and the `spec-and-types` job re-runs the sync plus the frontend codegen and fails if the synced spec or the generated types differ. The export needs the database because TypeORM connects while the providers are built; the queue and the S3 client connect lazily and are not required for it.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose logs video-worker
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", "<rootDir>/test/setup-env.ts"]` — without `dotenv/config`, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. `src/test/setup-env.ts` then forces `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (presigned URLs must be reachable from inside the container), redirects `S3_BUCKET` and `QUEUE_PREFIX` to `streamtube-test` so tests never touch dev data nor get consumed by the real `video-worker`, and honours `TEST_DB_NAME` / `TEST_S3_BUCKET` / `TEST_QUEUE_PREFIX` overrides for isolated parallel runs.
- `forceExit: true` — the Handlebars adapter of `@nestjs-modules/mailer` loads the native `@css-inline/css-inline` module, which keeps a `CustomGC` handle open and would otherwise block Jest from exiting after the run.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- `DatabaseModule` (`src/database/database.module.ts`) owns `TypeOrmModule.forRootAsync` and is shared by `AppModule` and `WorkerModule`
- Two entrypoints share the codebase: `src/main.ts` (HTTP API) and `src/worker.ts` (`WorkerModule` — BullMQ consumer, no controllers)

## Videos (Phase 03)

Upload, processing and playback of videos. Videos belong to the authenticated user's channel (`videos.channel_id → channels.id`) and are addressed publicly by `public_id` (11 URL-safe chars generated in `src/videos/public-id.util.ts`).

Modules:
- `src/storage/` — `StorageModule` / `StorageService`: S3 client (AWS SDK v3) against MinIO locally. Two clients: `S3_CLIENT` (internal endpoint `S3_ENDPOINT`, used by API and worker) and `S3_PUBLIC_CLIENT` (`S3_PUBLIC_ENDPOINT`, used only to presign URLs handed to browsers — SigV4 binds the host). Ensures the bucket exists on boot. Keys: `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`.
- `src/queue/` — `QueueModule`: `BullModule.forRootAsync` (Redis) + queue `video-processing` with `attempts`/exponential `backoff` from `QUEUE_*`/`VIDEO_PROCESSING_*`. Job name `process-video`, `jobId = video-<videoId>` (dedupe), payload `{ videoId, publicId, storageKey }`.
- `src/media/` — `MediaModule` / `FfmpegService`: spawns `ffprobe` (JSON metadata) and `ffmpeg` (one JPEG frame to stdout) via `child_process`; both binaries are installed in `Dockerfile.dev`.
- `src/videos/` — `VideosModule`: entity `Video`, `VideosService`, `VideosController`, `VideoProcessingProducer`, DTOs.
- `src/video-processing/` — `VideoProcessingModule`: `VideoProcessor` (`WorkerHost`) + `VideoProcessingService`; runs inside the `video-worker` container.

Status lifecycle (`videos.status`): `draft` (created on upload init) → `processing` (upload completed, job enqueued) → `ready` (duration, metadata, thumbnail stored) or `failed` (`processing_error` set after the last attempt; owner can re-enqueue).

Upload flow (10 GB, nothing streams through the API): `POST /videos` creates the draft and opens an S3 multipart upload → `POST /videos/:publicId/upload/part-urls` returns presigned `UploadPart` URLs (client PUTs parts straight to the storage) → `GET /videos/:publicId/upload/parts` lists uploaded parts (resume) → `POST /videos/:publicId/upload/complete` with `{ parts: [{ part_number, etag }] }` completes the multipart, verifies the real size with `HeadObject`, flips to `processing` and enqueues the job → `DELETE /videos/:publicId/upload` aborts and removes the draft.

Playback: `GET /videos/:publicId` (public for `ready`; owner sees any status via optional auth), `GET /videos/:publicId/stream`, `/download` (`Content-Disposition: attachment`) and `/thumbnail` answer `302` to short-lived presigned `GetObject` URLs — range requests (`206`) are served by the storage, not by the API. `POST /videos/:publicId/processing` re-enqueues a `failed` video (owner only).

Limits (env, validated by Joi): `UPLOAD_MAX_SIZE_BYTES` (10 GiB), `UPLOAD_PART_SIZE_BYTES` (64 MiB, 5 MiB–5 GiB), `UPLOAD_PART_URL_TTL_SECONDS` and `PLAYBACK_URL_TTL_SECONDS` (3600), allowed types `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` (`src/config/videos.config.ts`).

Error codes: `VIDEO_NOT_FOUND` 404, `VIDEO_FORBIDDEN` 403, `VIDEO_INVALID_STATE` 409, `VIDEO_TOO_LARGE` 413, `VIDEO_UNSUPPORTED_MEDIA_TYPE` 415, `VIDEO_INVALID_PART_NUMBER` 400, `VIDEO_UPLOAD_INVALID_PARTS` 400, `CHANNEL_NOT_FOUND` 404 — all `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`.

Optional authentication: `JwtAuthGuard` attaches `request.user` on `@Public()` routes when a valid Bearer token is present and stays anonymous otherwise; read it with `@OptionalUser()` (`src/auth/decorators/optional-user.decorator.ts`).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
