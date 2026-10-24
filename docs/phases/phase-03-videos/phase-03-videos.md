---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-03T15:00:04-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-03T14:58:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-03T14:56:11-03:00"
  docs/project-plan.md: "2026-10-03T13:10:53-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o backend de vídeos da Fase 03 no `nestjs-project/`: pré-cadastro do vídeo como rascunho ao iniciar o upload, upload de até 10GB direto ao object storage via S3 Multipart pré-assinado (sem passar bytes pela API), fila BullMQ/Redis com um worker FFmpeg em container próprio que extrai duração/metadados e gera o thumbnail, identificador público único por vídeo, reprodução via streaming e download por URL pré-assinada, e o ciclo `draft → processing → ready | failed` refletido no banco — com storage, fila e worker subindo no `compose.yaml` junto com a API.

---

## Step Implementations

### SI-03.1 — Estabelecer baseline de qualidade (lint de testes e encerramento do Jest)

**Description:** Deixar `npm run lint` e `npm test` saudáveis antes de adicionar código novo: a base herdada tem 150 erros de lint (regras type-aware em arquivos de teste com mocks `any`) e o Jest não encerra sozinho ao fim da suíte — ambos bloqueiam a Definition of Done da fase.

**Technical actions:**

1. Em `eslint.config.mjs`, adicionar um bloco de override para `**/*.spec.ts`, `**/*.integration-spec.ts`, `**/*.e2e-spec.ts` e `src/test/**` desligando as regras que não fazem sentido em testes com mocks (`@typescript-eslint/no-unsafe-member-access`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-return`, `no-unsafe-call`, `unbound-method`, `require-await`); o código de produção continua sob `recommendedTypeChecked`.
2. Corrigir os erros remanescentes em código de produção: em `src/channels/channels.service.ts`, substituir o cast `as any` em `isPgUniqueViolationOnColumn` por um type guard tipado (`err is QueryFailedError & { code?: string; detail?: string }`); em `src/test/create-test-data-source.ts`, trocar `Function` por `EntityTarget`-compatível (`(new (...args: any[]) => unknown) | string | EntitySchema<any>`) para eliminar `no-unsafe-function-type`.
3. Remover as duas variáveis não usadas apontadas pelo lint (`no-unused-vars`) nos specs onde ocorrem, sem alterar o comportamento dos testes.
4. Diagnosticar o handle aberto com `docker compose exec nestjs-api npx jest --runInBand --detectOpenHandles` e fechar o recurso na origem (ex.: `await module.close()` / `dataSource.destroy()` faltando em uma suíte); se o handle vier de uma dependência de infraestrutura que o teste não controla, registrar o motivo em `progress.md`.

**Tests:** _(empty — gate de qualidade; verificado pela própria execução de `npm run lint` e `npm test -- --runInBand`)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run lint` termina com código 0 e zero `error`
- `docker compose exec nestjs-api npm test -- --runInBand` termina sozinho (sem a mensagem "Jest did not exit one second after the test run has completed") com todos os testes existentes verdes
- `docker compose exec nestjs-api npx tsc --noEmit` continua saindo com código 0

---

### SI-03.2 — Instalar dependências e criar namespaces de configuração (storage, queue, videos)

**Description:** Instalar as bibliotecas decididas na fase e criar os três namespaces `registerAs` que a infraestrutura nova consome, estendendo o schema Joi e o `.env.example` com as variáveis canônicas.

**Technical actions:**

1. Instalar em `nestjs-project/`: `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5` (per `phase-03-videos/TD-01`), `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0` (per `phase-03-videos/TD-03`).
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT` (default `http://minio:9000`), `S3_PUBLIC_ENDPOINT` (default igual a `S3_ENDPOINT`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `streamtube-videos`), `S3_FORCE_PATH_STYLE` (boolean, default `true`) (per `phase-03-videos/TD-03`, `TD-05`, `TD-10`).
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `streamtube`), `VIDEO_PROCESSING_ATTEMPTS` (default `3`), `VIDEO_PROCESSING_BACKOFF_MS` (default `5000`), `WORKER_CONCURRENCY` (default `2`) (per `phase-03-videos/TD-01`, `TD-11`).
4. Criar `src/config/videos.config.ts` — `registerAs('videos', ...)` lendo `UPLOAD_MAX_SIZE_BYTES` (default `10737418240`), `UPLOAD_PART_SIZE_BYTES` (default `67108864`), `UPLOAD_PART_URL_TTL_SECONDS` (default `3600`), `PLAYBACK_URL_TTL_SECONDS` (default `3600`) e a allowlist fixa `['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']` (per `phase-03-videos/TD-12`).
5. Estender `src/config/env.validation.ts` com todas as variáveis acima (`S3_ACCESS_KEY` e `S3_SECRET_KEY` obrigatórias; demais com defaults; `UPLOAD_PART_SIZE_BYTES` entre 5 MiB e 5 GiB), registrar os três factories em `ConfigModule.forRoot({ load })` do `AppModule` e atualizar `.env.example` (e o `.env` local) com valores compatíveis com o Compose (`S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `REDIS_HOST=redis`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Unit: defaults aplicados, `S3_ACCESS_KEY`/`S3_SECRET_KEY` obrigatórios, `UPLOAD_PART_SIZE_BYTES` fora de 5 MiB–5 GiB rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação sobe com o `.env.example` preenchido e falha no bootstrap (erro Joi) quando `S3_ACCESS_KEY` ou `S3_SECRET_KEY` estão ausentes
- `S3_PUBLIC_ENDPOINT` ausente resulta em `storage.publicEndpoint === storage.endpoint`
- `UPLOAD_PART_SIZE_BYTES=1048576` (1 MiB) é rejeitado pelo schema com mensagem citando a variável

---

### SI-03.3 — Adicionar object storage e Redis ao Compose e FFmpeg à imagem de desenvolvimento

**Description:** Subir a infraestrutura nova da fase junto com a stack do backend: MinIO (imagem Bitnami congelada fixada por digest), Redis para o BullMQ e FFmpeg/ffprobe na imagem compartilhada por API e worker.

**Technical actions:**

1. Em `nestjs-project/compose.yaml`, adicionar o serviço `minio` com `image: bitnamilegacy/minio:2025.7.23@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7`, portas `9000:9000` (API S3) e `9001:9001` (console), `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` lidos de `S3_ACCESS_KEY`/`S3_SECRET_KEY` do `.env`, `MINIO_DEFAULT_BUCKETS=${S3_BUCKET}`, volume nomeado `minio_data:/bitnami/minio/data` e healthcheck `curl -f http://localhost:9000/minio/health/live` (per `phase-03-videos/TD-04`).
2. Adicionar o serviço `redis` com `image: redis:7-alpine`, porta `6379:6379`, healthcheck `redis-cli ping` e volume nomeado `redis_data` (per `phase-03-videos/TD-01`).
3. Em `Dockerfile.dev`, instalar `ffmpeg` via `apt-get install -y --no-install-recommends ffmpeg` junto aos pacotes já instalados, limpando `/var/lib/apt/lists` (per `phase-03-videos/TD-06`, `TD-07`).
4. Fazer `nestjs-api` depender de `minio` e `redis` com `condition: service_healthy`; declarar os volumes `minio_data` e `redis_data`; documentar as portas no `README.md` da raiz (tabela "Serviços disponíveis").

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.2 — as variáveis `S3_*`/`REDIS_*` usadas pelo Compose vêm do `.env` definido lá

**Acceptance criteria:**

- `docker compose up -d --build` sobe `db`, `mailpit`, `minio`, `redis` e `nestjs-api`, todos `running`/`healthy` em `docker compose ps`
- `curl -f http://localhost:9000/minio/health/live` responde 200 no host e o console MinIO abre em `http://localhost:9001` com as credenciais do `.env`
- `docker compose exec redis redis-cli ping` responde `PONG`
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` imprimem a versão instalada

---

### SI-03.4 — Criar StorageModule com clientes S3 e operações multipart/presign

**Description:** Encapsular todo o acesso ao object storage em um `StorageService` com dois `S3Client`s (interno e público) e as operações que upload, playback e worker precisam, garantindo a existência do bucket no bootstrap.

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` com os tokens `S3_CLIENT` e `S3_PUBLIC_CLIENT` e `src/storage/storage.module.ts` provendo os dois clientes via `useFactory` a partir de `storageConfig` (`endpoint` vs `publicEndpoint`, `forcePathStyle`, `region`, `credentials`), além de `StorageService`; exportar `StorageService` (per `phase-03-videos/TD-03`, `TD-10`).
2. Criar `src/storage/storage.service.ts` — `StorageService` implementando `OnModuleInit.ensureBucket()` (`HeadBucketCommand` → `CreateBucketCommand` quando `NotFound`), `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber, ttl)` (cliente público), `listParts(key, uploadId)` (pagina `ListPartsCommand` até `IsTruncated=false`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `headObject(key)`, `putObject(key, body, contentType)`, `deleteByPrefix(prefix)` (`ListObjectsV2Command` + `DeleteObjectCommand`), `presignGetObject(key, ttl, { responseContentDisposition?, responseContentType? })` (cliente público) e `presignInternalGetObject(key, ttl)` (cliente interno, para o worker) (per `phase-03-videos/TD-02`, `TD-08`).
3. Mapear erros do SDK em `completeMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) para uma exceção de storage tipada (`StorageInvalidPartsError`) que a camada de vídeos converte em erro de domínio; demais erros propagam.
4. Criar `src/test/storage.ts` com helpers de teste (`uploadTestObject`, `clearTestPrefix`) e `src/test/setup-env.ts` que força `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`, `S3_BUCKET = 'streamtube-test'` e `QUEUE_PREFIX = 'streamtube-test'` no processo do Jest; registrar o arquivo em `setupFiles` do `package.json` (jest) e de `test/jest-e2e.json`, logo após `dotenv/config`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilação com os dois clientes e `StorageService` | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: bucket criado no init; multipart create → PUT nas URLs pré-assinadas → listParts → complete → headObject com tamanho somado; abort remove partes; presign GET responde 206 a `Range`; deleteByPrefix apaga os objetos | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — MinIO precisa estar no Compose

**Acceptance criteria:**

- Ao subir a aplicação com um MinIO sem buckets, o bucket `S3_BUCKET` passa a existir sem intervenção manual
- Uma URL pré-assinada de `UploadPart` aceita um `PUT` com corpo arbitrário e devolve o header `ETag`
- `completeMultipartUpload` com um `ETag` inválido resulta em `StorageInvalidPartsError`
- Uma URL pré-assinada de `GetObject` com header `Range: bytes=0-99` responde `206 Partial Content` e `Content-Range: bytes 0-99/<tamanho>`
- URLs assinadas pelo cliente público usam o host de `S3_PUBLIC_ENDPOINT`; as do cliente interno usam `S3_ENDPOINT`

---

### SI-03.5 — Criar QueueModule com BullMQ e a fila `video-processing`

**Description:** Registrar a conexão Redis do BullMQ uma única vez e a fila de processamento de vídeo com as opções padrão de retry decididas, exportando o registro para produtores (API) e consumidor (worker).

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `videoJobId(videoId) => \`video-${videoId}\`` e o tipo `ProcessVideoJobData { videoId: string; publicId: string; storageKey: string }` (per `phase-03-videos/TD-01`).
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory })` com `connection: { host, port }` e `prefix: queue.prefix`; `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: { attempts, backoff: { type: 'exponential', delay }, removeOnComplete: true, removeOnFail: false } })` lendo `attempts`/`delay` do `queueConfig`; exportar `BullModule` (per `phase-03-videos/TD-01`, `TD-11`).
3. Criar `src/test/queue.ts` com helpers (`getVideoProcessingQueue(module)`, `drainQueue(queue)` via `obliterate({ force: true })`) para os testes de integração e e2e.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação com `BullModule.forRootAsync` + `registerQueue`; a `Queue` injetável com `getQueueToken(VIDEO_PROCESSING_QUEUE)` tem `defaultJobOptions.attempts` igual ao configurado e usa o `prefix` de teste | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.3 — Redis precisa estar no Compose

**Acceptance criteria:**

- Um módulo que importa `QueueModule` consegue injetar `Queue` de `video-processing` e `queue.add` grava o job no Redis sob o prefixo configurado
- Jobs adicionados sem opções herdam `attempts = VIDEO_PROCESSING_ATTEMPTS` e backoff exponencial de `VIDEO_PROCESSING_BACKOFF_MS`
- Adicionar duas vezes um job com o mesmo `jobId` resulta em um único job na fila

---

### SI-03.6 — Criar a entidade Video e a migration CreateVideos

**Description:** Persistir o vídeo ligado ao canal com os campos do Data Model (identificação, dono, título, status, chaves de storage, duração, metadados e `public_id`), gerar a migration e alinhar o teste do runner de migrations à terceira migration.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas do `### Data Model → Video` (enum `VideoStatus { DRAFT='draft', PROCESSING='processing', READY='ready', FAILED='failed' }`, `size_bytes` `bigint` com transformer para `number`, `metadata` `jsonb` tipado como `VideoMetadata`), `@ManyToOne(() => Channel, (channel) => channel.videos)` + `@JoinColumn({ name: 'channel_id' })`, `@Index` em `channel_id` e `@Index({ unique: true })` em `public_id` (per `phase-03-videos/TD-05`, `TD-09`, `TD-11`).
2. Adicionar em `src/channels/entities/channel.entity.ts` o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` (sem coluna nova).
3. Gerar a migration com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL (tipo enum `videos_status_enum`, FK para `channels`, índices, default `'draft'`).
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` em `imports` e exportando `TypeOrmModule` (providers são adicionados nos SIs seguintes).
5. Atualizar `src/database/migrations.integration-spec.ts`: incluir `Video` nas entidades, `CreateVideos*` nas migrations e `videos` em `MANAGED_TABLES`; no `beforeAll` dropar também os tipos enum (`DROP TYPE IF EXISTS ... CASCADE` para `verification_tokens_type_enum` e `videos_status_enum`) para tornar o teste idempotente; esperar 3 migrations e 5 tabelas; `undoLastMigration` remove `videos`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, `status` default `draft`, enum rejeita valor fora da lista, FK para `channels`, `size_bytes` round-trip como number, `metadata` jsonb round-trip, timestamps automáticos | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |
| Migrations | Integration: `runMigrations` aplica 3 migrations e cria `users`, `channels`, `refresh_tokens`, `verification_tokens`, `videos`; `undoLastMigration` remove `videos`; suíte idempotente em reexecução | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.2 — a tabela usa o enum de status fixado nas decisões carregadas em config

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com FK `channel_id → channels.id`, índice único em `public_id` e enum `videos_status_enum('draft','processing','ready','failed')`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Um vídeo criado sem `status` explícito é persistido como `draft`
- `src/database/migrations.integration-spec.ts` passa duas vezes seguidas no mesmo banco

---

### SI-03.7 — Criar exceções de domínio de vídeo e o gerador de `public_id`

**Description:** Fixar o catálogo de erros da fase como `DomainException`s e o utilitário que gera identificadores públicos curtos e únicos.

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as subclasses do `### Error Catalog`: `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `VideoForbiddenException` (403 `VIDEO_FORBIDDEN`), `VideoInvalidStateException(current, allowed[])` (409 `VIDEO_INVALID_STATE`), `VideoTooLargeException(maxBytes)` (413 `VIDEO_TOO_LARGE`), `VideoUnsupportedMediaTypeException(allowed[])` (415 `VIDEO_UNSUPPORTED_MEDIA_TYPE`), `VideoInvalidPartNumberException(partCount)` (400 `VIDEO_INVALID_PART_NUMBER`), `VideoUploadInvalidPartsException` (400 `VIDEO_UPLOAD_INVALID_PARTS`), `ChannelNotFoundException` (404 `CHANNEL_NOT_FOUND`).
2. Criar `src/videos/public-id.util.ts` — `PUBLIC_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'` (64 símbolos), `PUBLIC_ID_LENGTH = 11` e `generatePublicId(): string` mapeando cada byte de `crypto.randomBytes(11)` com `& 63` para o alfabeto (sem viés de módulo) (per `phase-03-videos/TD-09`).
3. Criar `src/videos/videos.constants.ts` com `PUBLIC_ID_MAX_RETRIES = 5`, `THUMBNAIL_FILE_NAME = 'thumbnail.jpg'`, `ORIGINAL_FILE_BASENAME = 'original'`, `THUMBNAIL_WIDTH = 640`, `THUMBNAIL_MAX_OFFSET_SECONDS = 10`, `THUMBNAIL_OFFSET_RATIO = 0.1` e a função `videoStorageKey(videoId, extension)` / `thumbnailStorageKey(videoId)` que materializam o layout `videos/{videoId}/...` (per `phase-03-videos/TD-05`, `TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DomainExceptionFilter` + novas exceções | Unit: cada exceção de vídeo mapeia para `{ statusCode, error, message }` com o código do catálogo | `src/common/filters/domain-exception.filter.spec.ts` |
| `generatePublicId` | Unit: sempre 11 caracteres do alfabeto; 10.000 gerações sem repetição; cobre `_` e `-`; `videoStorageKey`/`thumbnailStorageKey` produzem os prefixos esperados | `src/videos/public-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Um serviço que lança `VideoInvalidStateException('ready', ['draft'])` produz resposta HTTP `409` com `error: "VIDEO_INVALID_STATE"` e mensagem citando o status atual e os permitidos
- `generatePublicId()` devolve strings de exatamente 11 caracteres contendo apenas `A-Z a-z 0-9 _ -`
- `videoStorageKey('<uuid>', 'mp4')` devolve `videos/<uuid>/original.mp4` e `thumbnailStorageKey('<uuid>')` devolve `videos/<uuid>/thumbnail.jpg`

---

### SI-03.8 — Expor lookup de canal por usuário e autenticação opcional em rotas públicas

**Description:** Fechar as duas lacunas da Fase 02 que a fase precisa: resolver o canal do usuário autenticado (dono dos vídeos) e permitir que rotas `@Public()` reconheçam um JWT válido quando presente, para que o dono veja seus vídeos ainda não prontos pelo mesmo endpoint público.

**Technical actions:**

1. Adicionar em `src/channels/channels.service.ts` o método `findByUserId(userId: string): Promise<Channel | null>` usando `dataSource.getRepository(Channel).findOne({ where: { user_id: userId } })`; manter `ChannelsService` exportado por `ChannelsModule`.
2. Em `src/auth/guards/jwt-auth.guard.ts`, quando a rota é `@Public()` e há header `Authorization: Bearer <token>`, tentar `jwtService.verifyAsync` e anexar o payload em `request.user`; em falha de verificação seguir como anônimo (sem lançar); rotas não públicas mantêm o comportamento atual (401).
3. Criar `src/auth/decorators/optional-user.decorator.ts` — `@OptionalUser()` que devolve `request.user ?? null` tipado como `JwtPayload | null`, para handlers públicos que ramificam por dono.
4. Atualizar `.claude/rules/auth-jwt.md` com a semântica de autenticação opcional em rotas `@Public()` (token válido anexa `request.user`; inválido/ausente = anônimo).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `JwtAuthGuard` | Unit: rota pública sem header → `user` indefinido e `true`; rota pública com token válido → `request.user` preenchido; rota pública com token inválido → `true` sem `user`; rota protegida inalterada | `src/auth/guards/jwt-auth.guard.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `GET /` (público) com `Authorization: Bearer <token válido>` responde `200` e `GET /` com token inválido também responde `200`
- `POST /auth/logout` sem token continua respondendo `401`
- `ChannelsService.findByUserId(user.id)` devolve o canal criado no cadastro desse usuário

---

### SI-03.9 — Implementar pré-cadastro do vídeo e início do upload multipart (`POST /videos`)

**Description:** Criar o vídeo como rascunho ligado ao canal do usuário e iniciar o multipart upload no storage em uma única chamada, devolvendo os parâmetros que o cliente usa para enviar as partes direto ao storage.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` com `title?: string` (`@IsOptional() @IsString() @Length(1, 150)`), `filename: string` (`@IsString() @Length(1, 255)`), `content_type: string` (`@IsString()`), `size_bytes: number` (`@IsInt() @Min(1)`) (per `phase-03-videos/TD-12`).
2. Criar `src/videos/videos.service.ts` — `VideosService` injetando `Repository<Video>`, `ChannelsService`, `StorageService`, `videosConfig`. Implementar `create(userId, dto)`: resolver canal (`ChannelNotFoundException` se nulo); validar `content_type` na allowlist (`VideoUnsupportedMediaTypeException`) e `size_bytes <= maxSizeBytes` (`VideoTooLargeException`); derivar `title` do `filename` sem extensão quando ausente; gerar `public_id` com retry em `23505` até `PUBLIC_ID_MAX_RETRIES`; salvar `Video` com `status = draft`, `storage_key = videoStorageKey(id, ext)`; chamar `storage.createMultipartUpload` e persistir `upload_id`; calcular `part_count = ceil(size_bytes / partSizeBytes)` (per `phase-03-videos/TD-02`, `TD-09`, `TD-11`, `TD-12`).
3. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos') @Controller('videos')` com `@Post()` autenticado (`@ApiBearerAuth('access-token')`) chamando `videosService.create(user.sub, dto)` e respondendo `201` com o shape de `### API Contracts → POST /videos`; decorar com `@ApiOperation` e um `@ApiResponse` por status (201, 400, 401, 404, 413, 415) referenciando `ApiErrorEnvelope`.
4. Registrar `VideosService` e `VideosController` em `VideosModule`, importando `ChannelsModule`, `StorageModule` e `ConfigModule`; importar `VideosModule` em `AppModule`.
5. Criar `src/videos/videos.service.spec.ts` com mocks de repositório/storage/channels para a lógica de ramificação de `create`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.create` | Unit: título derivado do filename; allowlist e limite de tamanho lançam as exceções corretas; colisão de `public_id` (23505) gera novo id; `part_count` arredonda para cima | `src/videos/videos.service.spec.ts` |
| `VideosService.create` | Integration: persiste `Video` `draft` com `channel_id` do usuário, `upload_id` e `storage_key` reais no MinIO | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compila com `ChannelsModule`, `StorageModule`, `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |
| `POST /videos` | E2E: 201 com `public_id` de 11 chars e `upload.part_count`; 401 sem token; 400 corpo inválido; 413 acima de `UPLOAD_MAX_SIZE_BYTES`; 415 `content_type` fora da allowlist | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6, SI-03.7, SI-03.8

**Acceptance criteria:**

- `POST /videos` com `{ filename: "aula.mp4", content_type: "video/mp4", size_bytes: 150000000 }` e token válido retorna `201` com `status: "draft"`, `title: "aula"`, `public_id` de 11 caracteres e `upload: { upload_id, part_size_bytes: 67108864, part_count: 3, part_url_ttl_seconds: 3600 }`
- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos` com `size_bytes` maior que `UPLOAD_MAX_SIZE_BYTES` retorna `413` com `error: "VIDEO_TOO_LARGE"`
- `POST /videos` com `content_type: "application/pdf"` retorna `415` com `error: "VIDEO_UNSUPPORTED_MEDIA_TYPE"`
- Após a chamada, existe um multipart upload em andamento no storage para `videos/<id>/original.mp4` e nenhuma linha com `status` diferente de `draft`

---

### SI-03.10 — Emitir URLs pré-assinadas de partes e listar partes enviadas

**Description:** Permitir que o cliente obtenha URLs de `UploadPart` em lote e descubra quais partes já estão no storage para retomar um upload interrompido.

**Technical actions:**

1. Criar `src/videos/dto/request-part-urls.dto.ts` — `RequestPartUrlsDto` com `part_numbers: number[]` (`@IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsInt({ each: true }) @Min(1, { each: true })`).
2. Em `VideosService`, implementar `findOwnedVideo(publicId, userId)` (404 `VideoNotFoundException` / 403 `VideoForbiddenException`), `assertStatus(video, allowed[])` (409 `VideoInvalidStateException`), `createPartUrls(publicId, userId, partNumbers)` (exige `draft`; `part_number > part_count` → `VideoInvalidPartNumberException`; devolve `{ part_number, url, expires_at }` via `storage.presignUploadPart` com `UPLOAD_PART_URL_TTL_SECONDS`) e `listUploadedParts(publicId, userId)` (exige `draft`; `storage.listParts` → `{ part_number, etag, size_bytes }`) (per `phase-03-videos/TD-02`, `TD-12`).
3. Em `VideosController`, adicionar `@Post(':publicId/upload/part-urls')` (200) e `@Get(':publicId/upload/parts')` (200), ambos autenticados e documentados com `@ApiParam('publicId')`, `@ApiOperation` e `@ApiResponse` por status (200, 400, 401, 403, 404, 409).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createPartUrls` / `listUploadedParts` | Unit: 404/403/409 por dono e status; `part_number` fora do intervalo lança `VideoInvalidPartNumberException`; TTL aplicado | `src/videos/videos.service.spec.ts` |
| `VideosService.createPartUrls` + `listUploadedParts` | Integration: URL emitida aceita `PUT` real no MinIO e a parte aparece em `listUploadedParts` com `etag` | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:publicId/upload/part-urls`, `GET /videos/:publicId/upload/parts` | E2E: 200 com URLs no host público; 400 `part_numbers` vazio; 400 `VIDEO_INVALID_PART_NUMBER`; 403 outro usuário; 404 `publicId` inexistente | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `POST /videos/{publicId}/upload/part-urls` com `{ part_numbers: [1, 2] }` pelo dono retorna `200` com duas entradas `{ part_number, url, expires_at }` cujo `url` aponta para `S3_PUBLIC_ENDPOINT`
- `POST /videos/{publicId}/upload/part-urls` com `part_numbers: [999]` em um vídeo de 3 partes retorna `400` com `error: "VIDEO_INVALID_PART_NUMBER"`
- `GET /videos/{publicId}/upload/parts` após um `PUT` real na URL da parte 1 retorna `200` com `parts[0].part_number === 1` e `etag` preenchido
- Qualquer das duas rotas chamada por um usuário autenticado que não é dono retorna `403` com `error: "VIDEO_FORBIDDEN"`

---

### SI-03.11 — Concluir ou abortar o upload e enfileirar o processamento

**Description:** Fechar o multipart no storage, conferir o tamanho real do objeto, mover o vídeo para `processing` e publicar o job na fila; ou abortar o upload descartando o rascunho.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` com `parts: CompletedPartDto[]` (`@ValidateNested({ each: true }) @ArrayMinSize(1) @ArrayMaxSize(10000)`), onde `CompletedPartDto` tem `part_number: number` (`@IsInt() @Min(1)`) e `etag: string` (`@IsString() @IsNotEmpty()`).
2. Criar `src/videos/video-processing.producer.ts` — `VideoProcessingProducer` injetando `@InjectQueue(VIDEO_PROCESSING_QUEUE)` e expondo `enqueue(video)` que adiciona `PROCESS_VIDEO_JOB` com `ProcessVideoJobData` e `jobId: videoJobId(video.id)`; importar `QueueModule` em `VideosModule` (per `phase-03-videos/TD-01`, `TD-11`).
3. Em `VideosService`, implementar `completeUpload(publicId, userId, parts)`: exige `draft`; ordena partes por `part_number`; `storage.completeMultipartUpload` (mapeando `StorageInvalidPartsError` → `VideoUploadInvalidPartsException`); `storage.headObject` para o tamanho real — se maior que `UPLOAD_MAX_SIZE_BYTES`, apaga o objeto e o rascunho e lança `VideoTooLargeException`; grava `size_bytes` real, `upload_id = null`, `status = processing`; chama `producer.enqueue`; em falha ao enfileirar, grava `status = failed` com `processing_error` e relança (per `phase-03-videos/TD-02`, `TD-11`, `TD-12`).
4. Em `VideosService`, implementar `abortUpload(publicId, userId)`: exige `draft`; `storage.abortMultipartUpload` quando houver `upload_id`; remove a linha do vídeo.
5. Em `VideosController`, adicionar `@Post(':publicId/upload/complete')` (200, shape de `### API Contracts`) e `@Delete(':publicId/upload')` (204), autenticados e documentados (200/204, 400, 401, 403, 404, 409, 413).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` / `abortUpload` | Unit: ordenação das partes; mapeamento de `StorageInvalidPartsError`; objeto maior que o limite apaga e lança 413; falha do producer marca `failed` e relança; abort só em `draft` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: upload real de 2 partes no MinIO → `complete` deixa o objeto montado, `status = processing`, `upload_id` nulo e um job `video-<id>` na fila de teste do Redis; `abortUpload` remove multipart e linha | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:publicId/upload/complete`, `DELETE /videos/:publicId/upload` | E2E: 200 com `status: "processing"` após PUTs reais nas URLs; 400 `VIDEO_UPLOAD_INVALID_PARTS` com etag errado; 409 `VIDEO_INVALID_STATE` ao completar duas vezes; 204 no abort e 404 em leitura posterior | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5, SI-03.10

**Acceptance criteria:**

- `POST /videos/{publicId}/upload/complete` com a lista correta de `{ part_number, etag }` retorna `200` com `status: "processing"` e `size_bytes` igual ao tamanho real do objeto; o objeto `videos/<id>/original.<ext>` existe no storage e há um job `video-<id>` na fila `video-processing`
- `POST /videos/{publicId}/upload/complete` com um `etag` inválido retorna `400` com `error: "VIDEO_UPLOAD_INVALID_PARTS"` e o vídeo permanece `draft`
- Repetir o `complete` de um vídeo já em `processing` retorna `409` com `error: "VIDEO_INVALID_STATE"`
- `DELETE /videos/{publicId}/upload` em um rascunho retorna `204`; o multipart é abortado no storage e `GET /videos/{publicId}` passa a retornar `404`
- O mesmo vídeo nunca gera dois jobs na fila (mesmo `jobId`)

---

### SI-03.12 — Expor leitura do vídeo, streaming, download e thumbnail

**Description:** Entregar o identificador público como URL de acesso: leitura dos dados do vídeo (pública quando `ready`, completa para o dono) e redirecionamentos `302` para URLs pré-assinadas de reprodução, download e thumbnail servidas pelo storage com suporte a `Range`.

**Technical actions:**

1. Em `VideosService`, implementar `findForViewer(publicId, viewer: JwtPayload | null)`: carrega o vídeo com `channel`; se `status !== ready` e o viewer não é dono → `VideoNotFoundException`; devolve o shape de `### API Contracts → GET /videos/{publicId}` (campo `processing_error` somente para o dono) (per `phase-03-videos/TD-09`, `TD-11`).
2. Em `VideosService`, implementar `createPlaybackUrl(publicId)`, `createDownloadUrl(publicId)` e `createThumbnailUrl(publicId)`: exigem `ready` (caso contrário `VideoNotFoundException`, sem revelar existência); usam `storage.presignGetObject` com `PLAYBACK_URL_TTL_SECONDS`, `ResponseContentType = content_type` para playback, `ResponseContentDisposition: attachment; filename="<original_filename>"` para download e `thumbnail_key` para o thumbnail (per `phase-03-videos/TD-10`, `TD-12`).
3. Em `VideosController`, adicionar `@Public() @Get(':publicId')` (200, usando `@OptionalUser()`), `@Public() @Get(':publicId/stream')`, `@Public() @Get(':publicId/download')` e `@Public() @Get(':publicId/thumbnail')` respondendo `@Redirect()` `302` com `Location` pré-assinada; documentar com `@ApiOperation`, `@ApiResponse` 200/302 e 404 (`ApiErrorEnvelope`), sem `@ApiBearerAuth` nas rotas públicas.
4. Em `src/test/videos.ts`, criar helper `seedReadyVideo(dataSource, storage, channel)` que grava um objeto de vídeo real no bucket de teste e insere a linha `ready` correspondente (com `thumbnail_key` e um JPEG real), para os testes de playback não dependerem do worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findForViewer` / URLs de playback | Unit: anônimo vê apenas `ready`; dono vê qualquer status e `processing_error`; não-dono recebe 404 para `draft`/`processing`/`failed`; URLs usam `Content-Disposition` apenas no download | `src/videos/videos.service.spec.ts` |
| `GET /videos/:publicId`, `/stream`, `/download`, `/thumbnail` | E2E: 200 anônimo para `ready`; 404 anônimo para `processing`; 200 dono com token para `processing`; 302 com `Location` no host público; seguir o `Location` com `Range: bytes=0-99` responde 206 e `Content-Range`; `download` responde `Content-Disposition: attachment; filename="..."`; 404 para `publicId` inexistente | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/{publicId}` sem token para um vídeo `ready` retorna `200` com `public_id`, `title`, `status`, `duration_seconds`, `metadata`, `channel.nickname` e sem `processing_error`
- `GET /videos/{publicId}` sem token para um vídeo `processing` retorna `404` com `error: "VIDEO_NOT_FOUND"`; a mesma chamada com o token do dono retorna `200` com `status: "processing"`
- `GET /videos/{publicId}/stream` de um vídeo `ready` retorna `302` cujo `Location` responde `206 Partial Content` a `Range: bytes=0-99` com `Content-Range: bytes 0-99/<tamanho>`
- `GET /videos/{publicId}/download` retorna `302` cujo `Location`, quando seguido, traz `Content-Disposition: attachment; filename="<nome original>"`
- `GET /videos/{publicId}/thumbnail` retorna `302` para o `thumbnail.jpg` do vídeo; vídeos não `ready` retornam `404` em `stream`, `download` e `thumbnail`

---

### SI-03.13 — Criar MediaModule com FfmpegService (probe e captura de frame)

**Description:** Isolar a chamada aos binários `ffprobe`/`ffmpeg` em um serviço testável que lê a mídia por URL e devolve metadados tipados e o frame do thumbnail em memória.

**Technical actions:**

1. Criar `src/media/media.types.ts` com `VideoProbeResult { duration_seconds: number; width: number | null; height: number | null; codec: string | null; bitrate: number | null; frame_rate: number | null; format: string | null; size_bytes: number | null }` e `src/media/media.constants.ts` com os binários (`FFPROBE_BIN = 'ffprobe'`, `FFMPEG_BIN = 'ffmpeg'`) e `MEDIA_COMMAND_TIMEOUT_MS = 120000`.
2. Criar `src/media/ffmpeg.service.ts` — `FfmpegService.probe(inputUrl)` executando `ffprobe -v error -print_format json -show_format -show_streams <url>` via `execFile` (com `timeout` e `maxBuffer`), parseando `format.duration`, `format.bit_rate`, `format.format_name`, `format.size` e o primeiro stream `codec_type === 'video'` (`codec_name`, `width`, `height`, `r_frame_rate` convertido de fração para número); e `captureFrame(inputUrl, atSeconds, width)` executando `ffmpeg -v error -ss <at> -i <url> -frames:v 1 -vf scale=<width>:-2 -f image2 -c:v mjpeg pipe:1` e devolvendo o `Buffer` do stdout (per `phase-03-videos/TD-07`, `TD-08`).
3. Converter falhas dos binários (exit code ≠ 0, timeout, JSON inválido, stdout vazio) em `MediaProcessingError` com a mensagem de stderr, para o processador decidir retry/falha.
4. Criar `src/media/media.module.ts` exportando `FfmpegService` e `src/test/fixtures.ts` com `createTestVideoFile(durationSeconds)` que gera um MP4 pequeno com `ffmpeg -f lavfi -i testsrc=... -f lavfi -i sine=... -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart` em `os.tmpdir()` para os testes de integração.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: `probe` de um MP4 gerado devolve duração ≈ 2s, `width/height` 320x240, `codec` h264; `captureFrame` devolve um JPEG (magic bytes `FF D8 FF`) com largura 320 quando `width=320`; URL inexistente lança `MediaProcessingError` | `src/media/ffmpeg.service.integration-spec.ts` |
| `MediaModule` | Unit: compilação exportando `FfmpegService` | `src/media/media.module.spec.ts` |

**Dependencies:** SI-03.3 — FFmpeg instalado na imagem

**Acceptance criteria:**

- `probe()` sobre um arquivo MP4 de 2 segundos devolve `duration_seconds` entre 1.9 e 2.1, `width = 320`, `height = 240`, `codec = "h264"` e `frame_rate` numérico
- `captureFrame(url, 0.5, 320)` devolve um `Buffer` começando com os bytes `0xFF 0xD8 0xFF`
- `probe()` sobre uma URL que responde 404 lança `MediaProcessingError` com a saída de erro do `ffprobe` na mensagem
- `probe()` funciona com uma URL HTTP pré-assinada do MinIO (não apenas com caminho local)

---

### SI-03.14 — Processar vídeos no worker: metadados, thumbnail e ciclo de status

**Description:** Consumir a fila `video-processing`: ler o original por URL pré-assinada, extrair duração/metadados, gerar e gravar o thumbnail e levar o vídeo a `ready` — ou a `failed` com o motivo quando as tentativas se esgotam.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `VideoProcessingService.process(videoId)`: carrega o `Video` (ignora silenciosamente se inexistente ou já `ready`); `storage.presignInternalGetObject(storage_key)`; `ffmpeg.probe(url)`; calcula `at = min(duration * THUMBNAIL_OFFSET_RATIO, THUMBNAIL_MAX_OFFSET_SECONDS)`; `ffmpeg.captureFrame(url, at, THUMBNAIL_WIDTH)`; `storage.putObject(thumbnailStorageKey(id), buffer, 'image/jpeg')`; atualiza `duration_seconds`, `metadata`, `thumbnail_key`, `status = ready`, `processed_at = now()`, `processing_error = null`. Implementar `markFailed(videoId, reason)` que grava `status = failed` e `processing_error` (per `phase-03-videos/TD-07`, `TD-08`, `TD-11`).
2. Criar `src/video-processing/video-processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency })` estendendo `WorkerHost`; `process(job)` delega a `VideoProcessingService.process(job.data.videoId)` e relança erros para o BullMQ aplicar o backoff; `@OnWorkerEvent('failed')` chama `markFailed` somente quando `job.attemptsMade >= (job.opts.attempts ?? 1)`; `@OnWorkerEvent('active'|'completed')` registram log via `Logger` (per `phase-03-videos/TD-01`, `TD-11`).
3. Criar `src/video-processing/video-processing.module.ts` importando `QueueModule`, `StorageModule`, `MediaModule`, `TypeOrmModule.forFeature([Video])` e provendo `VideoProcessingService` + `VideoProcessor`; a concorrência vem de `queueConfig.workerConcurrency`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: vídeo inexistente/`ready` é ignorado; offset do thumbnail respeita o teto de 10s; falha do probe propaga sem alterar status; `markFailed` grava motivo | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessor` | Unit: `process` delega com `job.data.videoId`; `onFailed` só marca `failed` na última tentativa (`attemptsMade >= attempts`) | `src/video-processing/video-processor.spec.ts` |
| `VideoProcessingService.process` | Integration: vídeo `processing` com MP4 real no MinIO → `ready`, `duration_seconds ≈ 2`, `metadata.width = 320`, `thumbnail.jpg` existe no bucket com `Content-Type: image/jpeg`; objeto inválido (não-vídeo) → `MediaProcessingError` e `markFailed` deixa `failed` com `processing_error` | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingModule` | Unit: compilação com `QueueModule`, `StorageModule`, `MediaModule` e `forFeature([Video])` | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.4, SI-03.5, SI-03.6, SI-03.13

**Acceptance criteria:**

- Processar um vídeo `processing` cujo original é um MP4 válido deixa a linha com `status = "ready"`, `duration_seconds` preenchido, `metadata` com `width`, `height`, `codec`, `frame_rate`, `format`, `thumbnail_key = videos/<id>/thumbnail.jpg` e `processed_at` definido
- O objeto `videos/<id>/thumbnail.jpg` existe no storage e é um JPEG de 640px de largura
- Processar um vídeo cujo original não é mídia válida lança erro no job; após a última tentativa a linha fica `status = "failed"` com `processing_error` não nulo
- Reprocessar um vídeo já `ready` não lança erro nem altera a linha

---

### SI-03.15 — Criar o entrypoint do worker e o serviço `video-worker` no Compose

**Description:** Rodar o processador em um processo e container próprios, compartilhando o codebase e a configuração da API, com shutdown gracioso e watch em desenvolvimento.

**Technical actions:**

1. Criar `src/database/database.module.ts` — `DatabaseModule` encapsulando o `TypeOrmModule.forRootAsync` hoje inline em `AppModule` (mesmas opções: `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`); substituir o bloco inline por `DatabaseModule` em `AppModule`.
2. Criar `src/worker.module.ts` — `WorkerModule` com `ConfigModule.forRoot({ isGlobal: true, load: [appConfig, databaseConfig, storageConfig, queueConfig, videosConfig], validationSchema })`, `DatabaseModule` e `VideoProcessingModule` (sem controllers, sem `AuthModule`) (per `phase-03-videos/TD-06`).
3. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `app.enableShutdownHooks()`, log de início com fila e concorrência; o `WorkerHost` fecha o `Worker` do BullMQ no `SIGTERM`.
4. Adicionar scripts em `package.json`: `"start:worker": "node dist/worker"` e `"start:worker:dev": "nest start --watch --entryFile worker --path tsconfig.worker.json"`, criando `tsconfig.worker.json` que estende `tsconfig.build.json` com `outDir: ./dist-worker` para o watch do worker não disputar `dist/` com o da API; adicionar `/dist-worker` ao `.gitignore`.
5. Em `compose.yaml`, adicionar o serviço `video-worker` com o mesmo `build` de `nestjs-api`, o mesmo volume `.:/home/node/app`, `command: npm run start:worker:dev`, `env_file: .env`, dependendo de `db`, `redis` e `minio` (`service_healthy`); atualizar `nestjs-project/CLAUDE.md` (seção Development Environment) com o serviço e os comandos do worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilação com `DatabaseModule` e `VideoProcessingModule`, resolvendo `VideoProcessor` e sem `VideosController` registrado | `src/worker.module.spec.ts` |
| `DatabaseModule` | Unit: compilação expondo `DataSource` conectado ao `db` do Compose | `src/database/database.module.spec.ts` |

**Dependencies:** SI-03.14

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` e `docker compose logs video-worker` mostra o worker conectado à fila `video-processing`
- Completar um upload real pela API (`POST /videos/{publicId}/upload/complete`) com o worker no ar leva o vídeo a `status = "ready"` em até 60 segundos, com thumbnail no storage, sem intervenção manual
- `docker compose stop video-worker` encerra o processo sem erro de job interrompido no log (shutdown gracioso)
- `GET /` da API continua respondendo `200` enquanto o worker processa um vídeo (processos independentes)

---

### SI-03.16 — Permitir ao dono reprocessar um vídeo com falha

**Description:** Dar saída ao estado terminal `failed`: o dono reenfileira o processamento e o vídeo volta a `processing`.

**Technical actions:**

1. Em `VideosService`, implementar `reprocess(publicId, userId)`: `findOwnedVideo`; exige `status = failed` (`VideoInvalidStateException` caso contrário); limpa `processing_error`, grava `status = processing` e chama `producer.enqueue(video)`; em falha ao enfileirar, volta a `failed` com o erro e relança (per `phase-03-videos/TD-11`).
2. Em `VideosController`, adicionar `@Post(':publicId/processing')` autenticado respondendo `202 Accepted` com `{ id, public_id, status: "processing" }`, documentado (202, 401, 403, 404, 409).
3. Garantir que o `jobId` reutilizado (`video-<id>`) não colide com o job anterior: o job falho permanece no failed set (`removeOnFail: false`), então `enqueue` remove explicitamente o job antigo (`queue.getJob(jobId)?.remove()`) antes de adicionar o novo.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.reprocess` | Unit: 409 fora de `failed`; limpa erro e enfileira; falha do producer restaura `failed` | `src/videos/videos.service.spec.ts` |
| `VideoProcessingProducer.enqueue` | Integration: job falho pré-existente é removido e um novo job `video-<id>` aparece em `waiting` | `src/videos/video-processing.producer.integration-spec.ts` |
| `POST /videos/:publicId/processing` | E2E: 202 para vídeo `failed` do dono e `GET` subsequente mostra `processing`; 409 para vídeo `ready`; 403 para não-dono | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.11, SI-03.14

**Acceptance criteria:**

- `POST /videos/{publicId}/processing` pelo dono de um vídeo `failed` retorna `202` com `status: "processing"`, `processing_error` volta a nulo e um job `video-<id>` está na fila
- `POST /videos/{publicId}/processing` para um vídeo `ready` ou `draft` retorna `409` com `error: "VIDEO_INVALID_STATE"`
- `POST /videos/{publicId}/processing` por outro usuário retorna `403` com `error: "VIDEO_FORBIDDEN"`

---

### SI-03.17 — Atualizar OpenAPI, documentação de IA e coleção HTTP

**Description:** Refletir o estado real do código nos artefatos de documentação: spec OpenAPI exportado, `CLAUDE.md` da raiz e do backend com a seção de vídeos (módulo, endpoints, fila/worker, storage) e exemplos em `api.http`.

**Technical actions:**

1. Rodar `docker compose exec nestjs-api npm run openapi:export` e conferir que `nestjs-project/openapi.json` contém a tag `videos` com todos os endpoints de `### API Contracts` e seus códigos de erro.
2. Atualizar `nestjs-project/CLAUDE.md`: serviços do Compose (`minio`, `redis`, `video-worker` com portas e healthchecks), comandos do worker (`start:worker:dev`, logs), variáveis `S3_*`/`REDIS_*`/`UPLOAD_*`, módulos `storage/`, `queue/`, `media/`, `videos/`, `video-processing/`, o fluxo de upload multipart e a convenção de endpoint público vs interno do storage.
3. Atualizar `CLAUDE.md` da raiz: seção "Videos (Phase 03)" descrevendo módulo, endpoints, ciclo de status, fila BullMQ/Redis, worker FFmpeg e object storage; marcar a fila como BullMQ (não mais "TBD") na seção de arquitetura e atualizar `docs/diagrams/software-arch.mermaid` (`ContainerQueue(queue, "Message Queue", "Redis + BullMQ", ...)`).
4. Estender `nestjs-project/api.http` com a sequência de upload (criar vídeo → part-urls → PUT das partes → complete → GET status → stream/download → reprocess) e atualizar o `README.md` da raiz (funcionalidades da Fase 03, serviços e portas).

**Tests:** _(empty — documentação; verificada por `npm run openapi:export` e pelo teste existente `src/openapi-export.integration-spec.ts`)_

**Dependencies:** SI-03.1, SI-03.2, SI-03.3, SI-03.4, SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.9, SI-03.10, SI-03.11, SI-03.12, SI-03.13, SI-03.14, SI-03.15, SI-03.16

**Acceptance criteria:**

- `nestjs-project/openapi.json` lista os paths `/videos`, `/videos/{publicId}`, `/videos/{publicId}/upload/part-urls`, `/videos/{publicId}/upload/parts`, `/videos/{publicId}/upload/complete`, `/videos/{publicId}/upload`, `/videos/{publicId}/stream`, `/videos/{publicId}/download`, `/videos/{publicId}/thumbnail` e `/videos/{publicId}/processing`
- Todo arquivo, serviço do Compose, script npm e variável de ambiente citados em `CLAUDE.md` (raiz e `nestjs-project/`) existem no repositório
- `docs/diagrams/software-arch.mermaid` nomeia a fila como Redis + BullMQ

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → channels.id, not null, index |
| public_id | varchar(11) | unique, not null — identificador da URL pública (alfabeto `A-Za-z0-9_-`) |
| title | varchar(150) | not null — default derivado do `original_filename` sem extensão |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null — um dos tipos da allowlist |
| size_bytes | bigint | not null — declarado no init, substituído pelo tamanho real no complete |
| storage_key | varchar(512) | not null — `videos/{id}/original.{ext}` |
| thumbnail_key | varchar(512) | nullable — `videos/{id}/thumbnail.jpg` após processamento |
| upload_id | varchar(255) | nullable — `UploadId` do multipart enquanto `draft`; `null` após complete/abort |
| duration_seconds | numeric(10,3) | nullable — preenchido pelo worker |
| metadata | jsonb | nullable — `{ width, height, codec, bitrate, frame_rate, format }` |
| processing_error | text | nullable — motivo da última falha de processamento |
| processed_at | timestamp | nullable — momento em que o vídeo ficou `ready` |
| created_at | timestamp | not null, auto-generated |
| updated_at | timestamp | not null, auto-generated |

**Relations:** `Video` → `Channel` (many-to-one via `channel_id`); `Channel` has many `Video` (`channel.videos`, lado inverso sem coluna)
**Indexes:** unique on `public_id`; `(channel_id)`

#### Channel _(modificada)_

Sem coluna nova — recebe apenas a relação inversa `videos: Video[]` (`@OneToMany`). Nenhuma migration adicional.

---

### API Contracts

#### POST /videos (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, optional — 1 a 150 caracteres; quando ausente usa o `filename` sem extensão
- filename: string, required — 1 a 255 caracteres; a extensão define `storage_key`
- content_type: string, required — um de `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- size_bytes: integer, required — ≥ 1 e ≤ `UPLOAD_MAX_SIZE_BYTES` (10 GiB)

**Response 201:**
- id: string (uuid)
- public_id: string (11 chars)
- title: string
- status: `"draft"`
- original_filename: string
- content_type: string
- size_bytes: number
- created_at: string (ISO-8601)
- upload: object — `{ upload_id: string, part_size_bytes: number, part_count: number, part_url_ttl_seconds: number }`

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema
- 401: token ausente ou inválido
- 404 CHANNEL_NOT_FOUND: usuário autenticado sem canal
- 413 VIDEO_TOO_LARGE: `size_bytes` acima do limite
- 415 VIDEO_UNSUPPORTED_MEDIA_TYPE: `content_type` fora da allowlist

---

#### POST /videos/{publicId}/upload/part-urls (SI-03.10)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 a 1000 itens, cada um entre 1 e `part_count`

**Response 200:**
- parts: array — `[{ part_number: number, url: string, expires_at: string (ISO-8601) }]`; `url` é um `PUT` pré-assinado no host de `S3_PUBLIC_ENDPOINT`

**Error responses:**
- 400 VALIDATION_ERROR: lista vazia ou não inteira
- 400 VIDEO_INVALID_PART_NUMBER: `part_number` fora de `1..part_count`
- 401: token ausente ou inválido
- 403 VIDEO_FORBIDDEN: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_INVALID_STATE: vídeo não está em `draft`

---

#### GET /videos/{publicId}/upload/parts (SI-03.10)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array — `[{ part_number: number, etag: string, size_bytes: number }]` em ordem crescente de `part_number`

**Error responses:**
- 401: token ausente ou inválido
- 403 VIDEO_FORBIDDEN: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_INVALID_STATE: vídeo não está em `draft`

---

#### POST /videos/{publicId}/upload/complete (SI-03.11)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 a 10000 itens `{ part_number: integer ≥ 1, etag: string não vazio }`

**Response 200:**
- id: string (uuid)
- public_id: string
- status: `"processing"`
- size_bytes: number — tamanho real do objeto montado

**Error responses:**
- 400 VALIDATION_ERROR: corpo fora do schema
- 400 VIDEO_UPLOAD_INVALID_PARTS: storage rejeitou as partes (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`)
- 401: token ausente ou inválido
- 403 VIDEO_FORBIDDEN: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_INVALID_STATE: vídeo não está em `draft`
- 413 VIDEO_TOO_LARGE: objeto montado excede `UPLOAD_MAX_SIZE_BYTES` (objeto e rascunho são removidos)

---

#### DELETE /videos/{publicId}/upload (SI-03.11)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content — multipart abortado no storage e rascunho removido.

**Error responses:**
- 401: token ausente ou inválido
- 403 VIDEO_FORBIDDEN: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_INVALID_STATE: vídeo não está em `draft`

---

#### GET /videos/{publicId} (SI-03.12)

**Request headers:**
- Authorization: Bearer <access_token> — opcional; quando válido e o portador é o dono, libera vídeos fora de `ready`

**Response 200:**
- id: string (uuid)
- public_id: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- original_filename: string
- content_type: string
- size_bytes: number
- duration_seconds: number | null
- metadata: object | null — `{ width, height, codec, bitrate, frame_rate, format }`
- thumbnail_url: string | null — `/videos/{publicId}/thumbnail` quando há thumbnail
- processing_error: string | null — presente apenas para o dono
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null
- channel: object — `{ id: string, nickname: string, name: string }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente, ou vídeo fora de `ready` consultado por quem não é o dono

---

#### GET /videos/{publicId}/stream (SI-03.12)

**Response 302:** `Location` = URL pré-assinada `GetObject` do original (TTL `PLAYBACK_URL_TTL_SECONDS`, `response-content-type` = `content_type`); o storage atende `Range` com `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou vídeo fora de `ready`

---

#### GET /videos/{publicId}/download (SI-03.12)

**Response 302:** `Location` = URL pré-assinada `GetObject` do original com `response-content-disposition: attachment; filename="<original_filename>"`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente ou vídeo fora de `ready`

---

#### GET /videos/{publicId}/thumbnail (SI-03.12)

**Response 302:** `Location` = URL pré-assinada `GetObject` de `thumbnail_key` (`image/jpeg`).

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente, vídeo fora de `ready` ou sem thumbnail

---

#### POST /videos/{publicId}/processing (SI-03.16)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 202:**
- id: string (uuid)
- public_id: string
- status: `"processing"`

**Error responses:**
- 401: token ausente ou inválido
- 403 VIDEO_FORBIDDEN: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_INVALID_STATE: vídeo não está em `failed`

---

#### Validation Rules — Upload

| Field | Rule | Error |
|-------|------|-------|
| `title` | opcional; 1–150 caracteres | VALIDATION_ERROR |
| `filename` | obrigatório; 1–255 caracteres | VALIDATION_ERROR |
| `content_type` | obrigatório; ∈ allowlist `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` | VIDEO_UNSUPPORTED_MEDIA_TYPE (415) |
| `size_bytes` | inteiro ≥ 1; ≤ `UPLOAD_MAX_SIZE_BYTES` | VALIDATION_ERROR / VIDEO_TOO_LARGE (413) |
| `part_numbers[]` | 1–1000 inteiros; cada um em `1..part_count` | VALIDATION_ERROR / VIDEO_INVALID_PART_NUMBER (400) |
| `parts[]` | 1–10000 itens `{ part_number ≥ 1, etag não vazio }` | VALIDATION_ERROR |

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | ✓ |
| POST /videos/{publicId}/upload/part-urls | ✗ | ✗ (403) | ✓ |
| GET /videos/{publicId}/upload/parts | ✗ | ✗ (403) | ✓ |
| POST /videos/{publicId}/upload/complete | ✗ | ✗ (403) | ✓ |
| DELETE /videos/{publicId}/upload | ✗ | ✗ (403) | ✓ |
| GET /videos/{publicId} | ✓ apenas `ready` | ✓ apenas `ready` | ✓ qualquer status (+ `processing_error`) |
| GET /videos/{publicId}/stream | ✓ apenas `ready` | ✓ apenas `ready` | ✓ apenas `ready` |
| GET /videos/{publicId}/download | ✓ apenas `ready` | ✓ apenas `ready` | ✓ apenas `ready` |
| GET /videos/{publicId}/thumbnail | ✓ apenas `ready` | ✓ apenas `ready` | ✓ apenas `ready` |
| POST /videos/{publicId}/processing | ✗ | ✗ (403) | ✓ apenas `failed` |

Rotas públicas usam `@Public()` com autenticação opcional (token válido anexa `request.user`; inválido ou ausente = anônimo). "Dono" = usuário cujo canal (1:1) é o `channel_id` do vídeo.

---

### Error Catalog

**Error response format:** herdado da Fase 02 — `{ statusCode: number, error: string, message: string }`; validação usa `error: "VALIDATION_ERROR"` com `message` em array.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente; ou vídeo fora de `ready` acessado por quem não é o dono (inclui `stream`, `download`, `thumbnail`) |
| VIDEO_FORBIDDEN | 403 | operação de upload ou reprocessamento sobre vídeo de outro canal |
| VIDEO_INVALID_STATE | 409 | operação incompatível com o `status` atual (ex.: `complete` fora de `draft`, `processing` fora de `failed`) |
| VIDEO_TOO_LARGE | 413 | `size_bytes` declarado ou tamanho real do objeto acima de `UPLOAD_MAX_SIZE_BYTES` |
| VIDEO_UNSUPPORTED_MEDIA_TYPE | 415 | `content_type` fora da allowlist |
| VIDEO_INVALID_PART_NUMBER | 400 | `part_number` fora do intervalo `1..part_count` |
| VIDEO_UPLOAD_INVALID_PARTS | 400 | storage rejeitou a lista de partes no `CompleteMultipartUpload` |
| CHANNEL_NOT_FOUND | 404 | usuário autenticado sem canal associado |

---

### Events/Messages

#### video-processing / process-video

**Payload:**

```json
{ "videoId": "uuid", "publicId": "string", "storageKey": "videos/<uuid>/original.mp4" }
```

**Producer:** `VideoProcessingProducer` (`VideosModule`), chamado por `VideosService.completeUpload` e `VideosService.reprocess` (per `phase-03-videos/TD-01`, `TD-11`)
**Consumer:** `VideoProcessor` (`VideoProcessingModule`, processo `video-worker`) → `VideoProcessingService.process(videoId)` (per `phase-03-videos/TD-06`)
**Trigger:** vídeo transiciona para `processing` (upload concluído ou reprocessamento solicitado pelo dono)
**Job options:** `jobId = video-<videoId>` (deduplicação por vídeo), `attempts = VIDEO_PROCESSING_ATTEMPTS` (3), `backoff = { type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS }` (5s → 10s), `removeOnComplete: true`, `removeOnFail: false`
**Delivery semantics:** at-least-once — o processador é idempotente (re-probe e sobrescrita do thumbnail); após a última tentativa o vídeo fica `failed` com `processing_error` (per `phase-03-videos/TD-11`)
**Queue key space:** prefixo Redis `QUEUE_PREFIX` (`streamtube`); os testes usam `streamtube-test` para não serem consumidos pelo worker real

---

## Dependency Map

```
SI-03.1 (root — baseline de qualidade, independente)

SI-03.2 (root — dependências e config)
├── SI-03.3 — infra no Compose e FFmpeg na imagem
│   ├── SI-03.4 — StorageModule (MinIO)
│   ├── SI-03.5 — QueueModule (Redis)
│   └── SI-03.13 — MediaModule (FFmpeg)
└── SI-03.6 — entidade Video + migration

SI-03.7 (root — exceções e public_id)
SI-03.8 (root — findByUserId e auth opcional)

SI-03.4 + SI-03.6 + SI-03.7 + SI-03.8
└── SI-03.9 — POST /videos
    ├── SI-03.10 — part-urls e parts
    │   └── SI-03.11 — complete/abort (+ SI-03.5)
    └── SI-03.12 — leitura, stream, download, thumbnail

SI-03.4 + SI-03.5 + SI-03.6 + SI-03.13
└── SI-03.14 — processamento no worker
    └── SI-03.15 — entrypoint do worker + serviço video-worker

SI-03.11 + SI-03.14
└── SI-03.16 — reprocessamento

SI-03.1 … SI-03.16
└── SI-03.17 — OpenAPI, CLAUDE.md, api.http
```

Ordem linear sugerida: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4, SI-03.5, SI-03.6, SI-03.7, SI-03.8 (paralelos) → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16 → SI-03.17

---

## Deliverables

- [ ] SI-03.1 — Estabelecer baseline de qualidade (lint de testes e encerramento do Jest)
- [ ] SI-03.2 — Instalar dependências e criar namespaces de configuração (storage, queue, videos)
- [ ] SI-03.3 — Adicionar object storage e Redis ao Compose e FFmpeg à imagem de desenvolvimento
- [ ] SI-03.4 — Criar StorageModule com clientes S3 e operações multipart/presign
- [ ] SI-03.5 — Criar QueueModule com BullMQ e a fila `video-processing`
- [ ] SI-03.6 — Criar a entidade Video e a migration CreateVideos
- [ ] SI-03.7 — Criar exceções de domínio de vídeo e o gerador de `public_id`
- [ ] SI-03.8 — Expor lookup de canal por usuário e autenticação opcional em rotas públicas
- [ ] SI-03.9 — Implementar pré-cadastro do vídeo e início do upload multipart (`POST /videos`)
- [ ] SI-03.10 — Emitir URLs pré-assinadas de partes e listar partes enviadas
- [ ] SI-03.11 — Concluir ou abortar o upload e enfileirar o processamento
- [ ] SI-03.12 — Expor leitura do vídeo, streaming, download e thumbnail
- [ ] SI-03.13 — Criar MediaModule com FfmpegService (probe e captura de frame)
- [ ] SI-03.14 — Processar vídeos no worker: metadados, thumbnail e ciclo de status
- [ ] SI-03.15 — Criar o entrypoint do worker e o serviço `video-worker` no Compose
- [ ] SI-03.16 — Permitir ao dono reprocessar um vídeo com falha
- [ ] SI-03.17 — Atualizar OpenAPI, documentação de IA e coleção HTTP

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
