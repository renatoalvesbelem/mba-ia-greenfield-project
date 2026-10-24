---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-03T13:10:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-03T14:56:11-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-03T13:10:53-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-03T13:10:53-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-03T13:10:53-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-03T13:10:53-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-03T13:10:53-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de título/descrição/categoria/thumbnail customizada, visibilidade público/unlisted, fluxo rascunho → publicação e painel do canal (Fase 04); página de visualização com player, contagem de views e sugestões (Fase 05); interações sociais (Fase 06); interface de vídeo no `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a UI de upload/reprodução não faz parte desta fase; os contratos HTTP (upload multipart, stream/download) ficam prontos para a fase que a implementar.

**Sequencing notes:** Depends on Fase 01 (Configuração Base) and Fase 02 (Cadastro, Login e Gerenciamento de Conta) — vídeos pertencem ao canal 1:1 criado no cadastro e os endpoints de escrita exigem o JWT da Fase 02.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior):** autenticação JWT, usuários e canais; não toca vídeos.
- **Fase 04 — Gerenciamento de Vídeos e Canal (next):** categorias, edição de metadados do vídeo, visibilidade, publicação, painel e página pública do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq@^11.0.5, bullmq@^5.81.5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large File Upload Strategy (até 10GB) | decided | A (S3 Multipart Upload pré-assinado direto ao storage) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | S3 Client Library | decided | A (AWS SDK for JavaScript v3) | @aws-sdk/client-s3@^3.1146.0, @aws-sdk/s3-request-presigner@^3.1146.0 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Repo-wide | Local S3-compatible Server Image for Docker Compose | decided | A (`bitnamilegacy/minio:2025.7.23` fixada por digest) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Bucket and Object Key Layout | decided | A (bucket único `streamtube-videos`, prefixo `videos/{videoId}/`) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Topology | decided | A (mesmo codebase, entrypoint `src/worker.ts`, serviço `video-worker`) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail Tooling | decided | A (`ffprobe`/`ffmpeg` via `child_process`) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Worker Input Access Strategy | decided | A (FFmpeg lê por URL pré-assinada do endpoint interno, com range) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Public Video Identifier Strategy | decided | A (`public_id` de 11 chars via `crypto`, unique + retry) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Cross-layer | Playback Streaming and Download Delivery | decided | A (`302` para URL pré-assinada `GetObject`; download via `ResponseContentDisposition`) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Processing Failure Handling | decided | A (`draft → processing → ready \| failed`; 3 tentativas; `processing_error`; reprocess) | — |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Backend | Upload Limits and Presigned URL Policy | decided | A (10 GiB / 64 MiB / allowlist / TTL 1h, configuráveis) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-06 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-09 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-10 |
| Download do vídeo pelo usuário | phase-03-videos/TD-10 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — é a única opção com retry/backoff/deduplicação prontos e integração oficial do NestJS 11, com custo de infra mínimo (um container Redis). Fixar `@nestjs/bullmq@^11.0.5` (alinhado ao major do Nest instalado; o 12.x mira `@nestjs/core ^12`) e `bullmq@^5.81.x` (linha estável que empacota `ioredis`). pg-boss é a alternativa mais barata em infra, mas o diagrama C4 e o plano já preveem um container de fila e a integração Nest é artesanal.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`

### phase-03-videos/TD-02

**Recommendation:** Option A (Multipart pré-assinado direto ao storage) — é a única opção que satisfaz simultaneamente "10GB sem travar a API", retomada e compatibilidade com o S3 real; o diagrama C4 já prevê `API → storage (Uploads)` apenas como orquestração. O pré-cadastro como rascunho acontece na chamada de init — o vídeo nasce `draft` antes de qualquer byte subir.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Option A (AWS SDK v3) — mantém o código portável entre MinIO e S3 e cobre multipart + presign de forma oficial. Fixar `@aws-sdk/client-s3@^3.1146.0` e `@aws-sdk/s3-request-presigner@^3.1146.0` (versões em paridade — os pacotes do SDK v3 são publicados juntos).

**Libraries:** `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0`

### phase-03-videos/TD-04

**Recommendation:** Option A (`bitnamilegacy/minio:2025.7.23` fixada por digest) — preserva o MinIO previsto no plano com a cadeia de suprimento mais confiável disponível hoje, traz `curl`/`mc` para healthcheck e bootstrap e é adequada ao uso exclusivo em dev/test. Registrar o digest no `compose.yaml` e revisitar quando o projeto tiver produção (S3 real ou RustFS).

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A (bucket único, prefixo `videos/{videoId}/`) — menor superfície operacional e remoção por prefixo; a extensão do original vem do nome do arquivo enviado e o thumbnail é sempre `thumbnail.jpg` (TD-07). Buckets separados podem ser introduzidos quando houver política de acesso distinta.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option A (mesmo codebase, entrypoint e container próprios) — isola a carga do FFmpeg, respeita o C4 (worker lê/grava storage e atualiza o banco) e mantém um único projeto testável. A imagem de dev compartilhada (com FFmpeg) também permite que os testes de integração do processador rodem no container da API, conforme a convenção do projeto de rodar tudo em `nestjs-api`.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Option A (binários via `child_process`) — é a opção sem dependência, com saída JSON estável e sem o risco de um wrapper descontinuado. Thumbnail em JPEG com 640px de largura (altura proporcional) capturado em `t = min(10% da duração, 10s)`, sempre gravado como `thumbnail.jpg` (TD-05).

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option A (leitura por URL pré-assinada com range) — explora o seek nativo do FFmpeg e mantém o worker sem estado em disco; os retries da fila cobrem falhas transitórias de rede. O worker usa o endpoint interno do storage (não o público) para assinar essas URLs.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Option A (gerador próprio com `crypto` + unique + retry) — entrega o formato desejado sem dependência nem fricção ESM/CJS, e reaproveita o padrão de retry em `23505` já existente no projeto.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Option A (302 para URL pré-assinada, range servido pelo storage) — é o desenho do C4, mantém a API leve e o bucket privado; download reutiliza a mesma rota com `Content-Disposition`. O endpoint público do storage (`S3_PUBLIC_ENDPOINT`) é usado só para assinar URLs voltadas ao navegador; operações do servidor e do worker usam o endpoint interno.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Option A (enum único `draft → processing → ready | failed`) — espelha exatamente o ciclo do plano, deixa o retry para a fila (TD-01) e preserva o erro para diagnóstico; a reprocessagem manual pelo dono dá saída para o estado terminal. Publicação/visibilidade ficam para a Fase 04 em coluna própria.

**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Option A (10GiB / partes de 64MiB / allowlist / TTL 1h, configuráveis) — equilibra número de partes, retomada e simplicidade; a conferência via `HeadObject` fecha o limite de 10GB no lado do servidor. Valores vivem em um namespace de config próprio e são validados pelo schema Joi.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Custom BFF cookie-based session (`next/headers` + small helper) — the strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match and a ~50-LOC helper has a smaller blast radius than Auth.js.

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** `iron-session` encrypted container — single cookie carrying access + refresh + minimal user fingerprint; `httpOnly` blocks JS, encryption blocks accidental inspection, one `session.destroy()` on logout.

**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** Transparent BFF refresh on upstream 401 with per-request single-flight — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** `react-hook-form` + `@hookform/resolvers/zod` — decoupled from the mutation pathway, aligned with shadcn's canonical form primitive, Zod-first ergonomics matching the FE foundation.

**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Route Handler POST + client `fetch` — strict-BFF alignment; every mutation visible under `app/api/**`; reuses the Route-Handlers-as-functions test scaffold.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Server-rendered session + React Context Provider in RSC layout — no first-render flicker, no extra BFF endpoint; `router.refresh()` after mid-session mutations.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** RSC processes the e-mail token server-side; Client form below for the reset's input step — first-paint-correct and a single integration pattern across confirmation and reset flows.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Documentação de operações, respostas por status e contratos de erro (envelope de phase-02-auth/TD-07) exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`).

**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exportado) — o custo marginal sobre a UI runtime é um npm script (`openapi:export`) e o benefício é uma fundação para codegen offline do frontend (`scripts/sync-openapi.sh` copia o spec para `next-frontend/`).

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Swagger UI apenas em dev/staging via env flag `SWAGGER_ENABLED`) — alinha com a postura defensiva da Fase 02; o `openapi.json` commitado cumpre o papel de spec consultável fora da UI.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Error responses follow `{ statusCode, error, message }`; services throw `DomainException` subclasses (`src/common/exceptions/domain.exception.ts`) mapped by `DomainExceptionFilter`; validation errors use `error: "VALIDATION_ERROR"` with an array `message`. _(from phase 02)_
- `JwtAuthGuard` is registered globally via `APP_GUARD` in `AuthModule`; every endpoint is protected by default and public routes opt out with `@Public()`; handlers read the caller via `@CurrentUser()` (`JwtPayload { sub, email }`). _(from phase 02)_
- Request DTOs use `class-validator` decorators only (the `@nestjs/swagger` CLI plugin infers schemas); the global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted`, `transform`. _(from phase 02)_
- Entities use `@Entity('snake_table')`, UUID PKs, snake_case columns, `@CreateDateColumn`/`@UpdateDateColumn`; schema changes go through `npm run migration:generate` (timestamped `src/database/migrations/*-Name.ts`), never `synchronize`. _(from phase 02)_
- Each domain owns its module, entity, service and `TypeOrmModule.forFeature([...])`; cross-domain writes go through the owning service (e.g., `UsersService` delegates channel creation to `ChannelsService`). _(from phase 02)_
- Unique-value collisions are resolved by pre-check + retry on PostgreSQL `23505` (nickname pattern in `ChannelsService`), without SAVEPOINTs in the creation path. _(from phase 02)_
- Tests: `*.spec.ts` (unit, mocked collaborators), `*.integration-spec.ts` (real DB/services via `createTestDataSource` + `cleanAllTables`), `test/*.e2e-spec.ts` (supertest, reproduces `main.ts` global pipes/filters, clears `ThrottlerStorage` in `beforeEach`); integration/e2e run with `--runInBand`. _(from phase 02)_
- Every controller carries `@ApiTags`, `@ApiOperation` and one `@ApiResponse` per status, error responses referencing `ApiErrorEnvelope` via `getSchemaPath`; protected handlers add `@ApiBearerAuth('access-token')`; `openapi.json` is regenerated with `npm run openapi:export` and synced with `scripts/sync-openapi.sh`. _(from phase 02 — task openapi-docs-nestjs)_
- All `npm`/`npx`/test commands run inside the `nestjs-api` container; service hosts always use Compose service names (`db`, `mailpit`), never `localhost`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout`. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships sending the e-mail; the reset-password destination screen is absent from Figma. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | umbrella bullet deferred to the phase that lands the missing confirmação and reset-password screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Extract relevant to this phase (Feature Implementation Checklist + Future Types):

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, enum values, relations |
| Service with branching + DB | Unit: branch logic (mock repo/collaborators) + Integration: DB contract |
| Service with side-effect dep (object storage, queue) | Integration: real MinIO / real Redis queue in Docker — no mocks for infra available in Compose |
| Module with configured imports (`TypeOrmModule.forFeature`, `BullModule.registerQueue`, S3 client provider) | Unit: compilation test |
| Controller | E2E only (supertest) — status codes, auth enforcement, response shape; do NOT unit test |
| DTO | E2E: one validation wiring test per endpoint |
| Queue consumer / processor | Unit: branch logic (mock deps) + Integration: real DB + storage + FFmpeg, calling `process(job)` directly |
| Config validation (Joi) | Unit: schema accepts defaults / rejects invalid values |
| Custom decorators / pure helpers (id generator) | Unit |

### next-frontend

_Deferred subproject — UI de vídeo fora do escopo desta fase; testing requirements serão definidos na fase que a implementar._
