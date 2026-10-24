# phase-03-videos — Progress

**Status:** completed
**SIs:** 17/17 completed

### SI-03.1 — Estabelecer baseline de qualidade (lint de testes e encerramento do Jest)
- **Status:** completed
- **Tests:** no tests — `npm run lint` exit 0 (antes: 150 erros), `npx tsc --noEmit` exit 0
- **Observations:**
  - Os 150 erros herdados eram quase todos regras type-aware (`no-unsafe-*`, `unbound-method`, `require-await`) em arquivos de teste com mocks; desligadas só para `*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts` e `src/test/**` via override no `eslint.config.mjs`. Código de produção segue sob `recommendedTypeChecked`.
  - Em `channels.service.ts` o `as any` do erro do PostgreSQL virou um tipo `PgQueryFailedError` (`code`/`detail` opcionais); em `create-test-data-source.ts` o tipo `Function` virou `EntityClass`.
  - `--detectOpenHandles` apontou um único handle (`CustomGC`) vindo do módulo nativo `@css-inline/css-inline`, carregado pelo `HandlebarsAdapter` do `@nestjs-modules/mailer` — não é fechável pelos testes. Configurado `forceExit: true` no Jest (unit/integration e e2e) para a suíte encerrar sozinha.
  - O script `test:e2e` não tinha `--runInBand` (ao contrário do que o `CLAUDE.md` afirmava); com a segunda suíte e2e (vídeos), os workers do Jest passaram a limpar o mesmo banco em paralelo e derrubar um ao outro (FK de `refresh_tokens`/`videos`). Flag adicionada ao script.
  - O teste de migrations herdado não era idempotente (não dropava o enum `verification_tokens_type_enum`) e, ao falhar, deixava o banco sem tabelas, derrubando o e2e em cascata; a correção fica no SI-03.6, que reescreve esse teste para incluir a migration de vídeos.

### SI-03.2 — Instalar dependências e criar namespaces de configuração (storage, queue, videos)
- **Status:** completed
- **Tests:** 9/9 passing (env.validation.integration-spec.ts — defaults de storage/fila/upload, chaves S3 obrigatórias, limites do tamanho de parte)
- **Observations:**
  - Instalados `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`, `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0`.
  - `S3_PUBLIC_ENDPOINT` cai para `S3_ENDPOINT` quando ausente; `src/test/setup-env.ts` (novo `setupFiles` do Jest) força o endpoint público igual ao interno e redireciona bucket/prefixo da fila para `streamtube-test`, com overrides `TEST_DB_NAME`/`TEST_S3_BUCKET`/`TEST_QUEUE_PREFIX` para isolar execuções paralelas.

### SI-03.3 — Adicionar object storage e Redis ao Compose e FFmpeg à imagem de desenvolvimento
- **Status:** completed
- **Tests:** no tests — `docker compose ps` com `minio`, `redis`, `db`, `mailpit` healthy; `ffprobe -version` dentro de `nestjs-api` responde 5.1.9
- **Observations:**
  - `quay.io/minio/minio` passou a responder 401 e `minio/minio` sumiu do Docker Hub; a imagem usada é `bitnamilegacy/minio:2025.7.23` fixada por digest (TD-04). O bucket padrão é criado pelo próprio container via `MINIO_DEFAULT_BUCKETS`.

### SI-03.4 — Criar StorageModule com clientes S3 e operações multipart/presign
- **Status:** completed
- **Tests:** 8/8 passing (storage.module.spec.ts: 1 unit, storage.service.integration-spec.ts: 7 integration contra o MinIO)
- **Observations:**
  - As URLs pré-assinadas embutem o host do `S3Client` que assinou; o módulo mantém dois clientes (`S3_CLIENT` interno, `S3_PUBLIC_CLIENT` público) e o teste confirma o host de cada um sobrescrevendo `S3_PUBLIC_ENDPOINT`.
  - Partes de multipart precisam de ≥ 5 MiB exceto a última — o teste de integração sobe 2 × 5 MiB + 1 parte pequena.

### SI-03.5 — Criar QueueModule com BullMQ e a fila `video-processing`
- **Status:** completed
- **Tests:** 4/4 passing (queue.module.spec.ts — compila, defaultJobOptions, prefixo de teste, deduplicação por jobId)
- **Observations:**
  - A fila é registrada com `registerQueueAsync` para ler `attempts`/`backoff` do `queueConfig`; `removeOnFail: false` mantém o job falho inspecionável.

### SI-03.6 — Criar a entidade Video e a migration CreateVideos
- **Status:** completed
- **Tests:** 21/21 passing em src/videos (video.entity.integration-spec.ts, videos.module.spec.ts + specs do SI-03.7); migrations.integration-spec.ts 2/2 passing duas vezes seguidas; 65/65 nos specs existentes migrados para `TEST_ENTITIES`
- **Observations:**
  - Migration gerada: `1791051371718-CreateVideos.ts` (enum `videos_status_enum`, índice único em `public_id`, índice em `channel_id`, FK para `channels`).
  - Como `Channel` passou a referenciar `Video`, todos os `DataSource` de teste precisam registrar a entidade — a lista agora é a constante `TEST_ENTITIES` em `src/test/create-test-data-source.ts`.
  - Os `DROP TABLE` do teste de migrations rodavam em `Promise.all` e passaram a gerar `deadlock detected` com a FK `videos → channels`; viraram sequenciais. O teste também dropa os tipos enum, o que o torna idempotente.

### SI-03.7 — Criar exceções de domínio de vídeo e o gerador de `public_id`
- **Status:** completed
- **Tests:** 26/26 passing (domain-exception.filter.spec.ts, public-id.util.spec.ts, videos.constants.spec.ts)
- **Observations:** none

### SI-03.8 — Expor lookup de canal por usuário e autenticação opcional em rotas públicas
- **Status:** completed
- **Tests:** 12/12 passing (jwt-auth.guard.spec.ts, channels.service.integration-spec.ts)
- **Observations:**
  - Em rotas `@Public()` o guard tenta anexar `request.user` quando há Bearer válido e segue anônimo caso contrário; `@OptionalUser()` expõe `JwtPayload | null`. Documentado em `.claude/rules/auth-jwt.md`.

### SI-03.9 — Implementar pré-cadastro do vídeo e início do upload multipart (`POST /videos`)
- **Status:** completed
- **Tests:** videos.service.spec.ts (42 unit, cobre SI-03.9 a SI-03.16), videos.service.integration-spec.ts 4/4, videos.module.spec.ts 1/1, videos.e2e-spec.ts 25/25 (todos os SIs da API)
- **Observations:**
  - O `id` do vídeo é gerado com `crypto.randomUUID()` antes do insert para que `storage_key` (`videos/{id}/original.{ext}`) exista já no `CreateMultipartUpload`.
  - Colisão de `public_id` segue o padrão de nickname: pré-check + retry em `23505`; o type guard do erro do PostgreSQL foi extraído para `src/common/database/pg-errors.ts` e passou a ser compartilhado com `ChannelsService`.

### SI-03.10 — Emitir URLs pré-assinadas de partes e listar partes enviadas
- **Status:** completed
- **Tests:** cobertos em videos.service.spec.ts, videos.service.integration-spec.ts e videos.e2e-spec.ts (URLs no host público, 400 `VIDEO_INVALID_PART_NUMBER`, 403, 404, PUT real + listagem com etag)
- **Observations:** none

### SI-03.11 — Concluir ou abortar o upload e enfileirar o processamento
- **Status:** completed
- **Tests:** cobertos em videos.service.spec.ts, videos.service.integration-spec.ts (upload real de 2 partes → `processing` + job `video-<id>` no Redis) e videos.e2e-spec.ts (200, 400 `VIDEO_UPLOAD_INVALID_PARTS`, 409, 204 abort)
- **Observations:**
  - Nos testes, as partes de 5 MiB são enviadas direto por `storageService.presignUploadPart` para não depender de arquivos de 64 MiB; a validação de `part_count` é coberta pelos testes de `createPartUrls`.

### SI-03.12 — Expor leitura do vídeo, streaming, download e thumbnail
- **Status:** completed
- **Tests:** cobertos em videos.service.spec.ts e videos.e2e-spec.ts (anônimo vs dono, 302 + `Range` → 206/`Content-Range`, `Content-Disposition: attachment`, thumbnail)
- **Observations:**
  - Rotas de redirect usam `@Redirect()` devolvendo `{ url, statusCode: 302 }`; `seedReadyVideo` (`src/test/videos.ts`) grava um MP4 real e um JPEG no bucket de teste para os testes de playback não dependerem do worker.

### SI-03.13 — Criar MediaModule com FfmpegService (probe e captura de frame)
- **Status:** completed
- **Tests:** 7/7 passing (media.module.spec.ts, ffmpeg.service.integration-spec.ts — probe e captureFrame em arquivo local e via HTTP com Range)
- **Observations:**
  - Fixtures de vídeo são geradas em tempo de teste com `ffmpeg -f lavfi` (`src/test/fixtures.ts`), sem binários no repositório.

### SI-03.14 — Processar vídeos no worker: metadados, thumbnail e ciclo de status
- **Status:** completed
- **Tests:** 17/17 passing (video-processing.service.spec.ts: 9 unit, video-processor.spec.ts: 6 unit, video-processing.module.spec.ts: 1, video-processing.service.integration-spec.ts: MP4 real → ready com thumbnail JPEG no MinIO; objeto inválido → failed com processing_error)
- **Observations:**
  - `VideoProcessingModule` importa `UsersModule` para que `autoLoadEntities` enxergue `Channel` e `User` (relações inversas de `Video.channel`); sem isso o worker falhava com `Entity metadata for Video#channel was not found`.
  - A concorrência do worker é aplicada em `onApplicationBootstrap` via `this.worker.concurrency` (setter do `Worker` do BullMQ), lida de `WORKER_CONCURRENCY`.
  - `markFailed` só roda no evento `failed` da última tentativa (`attemptsMade >= opts.attempts`); tentativas intermediárias ficam com o backoff da fila.

### SI-03.15 — Criar o entrypoint do worker e o serviço `video-worker` no Compose
- **Status:** completed
- **Tests:** 2/2 passing (worker.module.spec.ts, database.module.spec.ts); container `video-worker` sobe com `nest start --watch` e loga `Video worker started: queue="video-processing" concurrency=2`
- **Observations:**
  - `tsconfig.worker.json` precisou de `exclude` próprio incluindo `dist-worker` — `extends` não faz merge de arrays e, na segunda compilação, o `tsc` tratava os `.d.ts` emitidos como entrada (`TS5055`).
  - `TypeOrmModule.forRootAsync` saiu do `AppModule` para `src/database/database.module.ts`, compartilhado por API e worker.

### SI-03.16 — Permitir ao dono reprocessar um vídeo com falha
- **Status:** completed
- **Tests:** cobertos em videos.service.spec.ts, video-processing.producer.integration-spec.ts 2/2 (job falho removido e reenfileirado com o mesmo `jobId`) e videos.e2e-spec.ts (202, 409, 403)
- **Observations:** none

### SI-03.17 — Atualizar OpenAPI, documentação de IA e coleção HTTP
- **Status:** completed
- **Tests:** no tests — `npm run openapi:export` regenerou `nestjs-project/openapi.json` com os 10 paths de `/videos` (tag `videos`); `openapi-export.integration-spec.ts` segue verde
- **Observations:**
  - `scripts/sync-openapi.sh` executado e `next-frontend/openapi.json` regenerado; `npm run openapi:types` no container do frontend atualizou `lib/api/types.gen.ts` com os 10 paths de `/videos`. Frontend verde depois da sincronia: `tsc --noEmit` exit 0, lint sem erros (1 warning pré-existente de `react-hook-form` em `signup-form.tsx`), 67/67 testes Vitest.
  - Criado `.github/workflows/openapi-freshness.yml` (guard citado em `next-frontend/CLAUDE.md` que ainda não existia), com dois jobs: `backend-spec` regenera `nestjs-project/openapi.json` a partir dos controllers e falha em qualquer diff; `spec-and-types` roda `scripts/sync-openapi.sh` + `npm run openapi:types` e falha em diff do spec sincronizado ou dos tipos gerados.
  - Ambos ensaiados localmente nos dois caminhos: as sequências são idempotentes com os arquivos atuais e reescrevem artefatos defasados (testes removendo os paths de `/videos` do spec do frontend e marcando o spec do backend como `STALE`).
  - O `backend-spec` precisa só de PostgreSQL como service: quebrando cada host isoladamente, apenas o banco faz o export falhar (o TypeORM conecta durante a construção dos providers; fila e cliente S3 conectam sob demanda). Node fixado em 25.6.0 e 22.16.0 nos jobs, iguais aos `Dockerfile.dev` de cada subprojeto.
  - `lib/api/contracts.ts` não ganhou aliases de vídeo: o barrel só recebe alias quando o endpoint é efetivamente consumido por um Route Handler do BFF, e a UI de vídeo é de uma fase posterior.
  - `CLAUDE.md` (raiz e `nestjs-project/`), `README.md`, `api.http` e `docs/diagrams/software-arch.mermaid` atualizados para o estado real do código (fila = Redis + BullMQ).
