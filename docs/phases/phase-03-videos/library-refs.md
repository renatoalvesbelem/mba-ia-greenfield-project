---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-03T15:00:00-03:00"
  bullmq:
    version: "^5.81.5"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-03T15:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T15:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1146.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T15:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-03T14:56:11-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase, taken from the official documentation of each library (docs.nestjs.com, docs.bullmq.io, docs.aws.amazon.com) and cross-checked against the published type definitions of the pinned versions. Re-fetch when the underlying TD changes.

## @nestjs/bullmq

**Source:** `/nestjs/docs.nestjs.com` → Techniques → Queues (BullMQ section). Maps to `phase-03-videos/TD-01` and `phase-03-videos/TD-06`. Version `11.0.5` declares `peerDependencies: bullmq ^3 || ^4 || ^5 || ^6`, `@nestjs/core ^10 || ^11` — the 12.x line targets Nest 12 and is out of scope.

### Install

```bash
npm install --save @nestjs/bullmq bullmq
```

### Root registration (shared Redis connection)

`BullModule.forRoot()` / `forRootAsync()` registers the configuration every queue in the application inherits. Accepted options (`BullRootModuleOptions extends QueueOptions`): `connection` (ioredis `ConnectionOptions` — `host`, `port`), `prefix` (prefix for all Redis keys, default `bull`), `defaultJobOptions`, `settings`. `forRootAsync` follows the usual `imports` / `inject` / `useFactory` shape:

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (queue: ConfigType<typeof queueConfig>) => ({
    connection: { host: queue.redisHost, port: queue.redisPort },
    prefix: queue.prefix,
  }),
});
```

The factory context only sees providers that are global — register `ConfigModule.forRoot({ isGlobal: true })` (already the case in `AppModule`), same gotcha as `MailerModule.forRootAsync`.

### Queue registration and producers

```typescript
BullModule.registerQueue({
  name: 'video-processing',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
```

`RegisterQueueOptions` extends BullMQ `QueueOptions` minus `connection` (inherited from `forRoot`), plus `name`, `configKey`, `processors` (sandboxed processors), `forceDisconnectOnShutdown`. Inject the queue into a service:

```typescript
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

await this.queue.add('process-video', { videoId }, { jobId: `video-${videoId}` });
```

`registerQueue` must be imported by every module that injects the queue (API module that produces, worker module that consumes). The module that calls `registerQueue` can re-export `BullModule` so consumers share the registration.

### Consumers (`WorkerHost`)

```typescript
@Processor('video-processing', { concurrency: 2 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoJobData>): Promise<void> { ... }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoJobData> | undefined, error: Error) { ... }
}
```

`@Processor` overloads: `Processor(queueName)`, `Processor(queueName, workerOptions)`, `Processor({ name, scope, configKey })`, `Processor(processorOptions, workerOptions)`. The second argument is BullMQ `WorkerOptions` (`concurrency`, `lockDuration`, `stalledInterval`, `maxStalledCount`, `limiter`, `autorun`). `process(job)` receives only the job; its return value is stored on the job. `@OnWorkerEvent('active' | 'completed' | 'failed' | 'progress' | ...)` listens to worker-local events; `failed` receives `(job, error)` — `job` is `undefined` when the failure is not tied to a job (connection errors). Queue-wide events use `@QueueEventsListener(queue)` + `QueueEventsHost` + `@OnQueueEvent`.

### Lifecycle

`WorkerHost` starts the BullMQ `Worker` on module init and closes it on application shutdown — the worker entrypoint must call `app.enableShutdownHooks()` so `SIGTERM` from Docker drains the in-flight job before exit. Sandboxed processors (`processors: [join(__dirname, 'processor.js')]`) run in forked processes without DI — not used here (the processor needs TypeORM repositories and the storage service).

### Testing notes

- Module compilation tests need a reachable Redis (`BullModule.forRoot` opens the connection lazily, but `Queue` instantiation validates options) — use the Compose `redis` service through env, never `localhost`.
- To assert a job was enqueued: `const queue = module.get<Queue>(getQueueToken('video-processing'))`; `await queue.getJob(jobId)` / `await queue.getJobs(['waiting', 'delayed'])`; clean with `await queue.obliterate({ force: true })` in `beforeEach`.
- Point tests at an isolated key space via `prefix` (`QUEUE_PREFIX`) so the real `video-worker` container never consumes jobs created by the test run.

## bullmq

**Source:** `/taskforcesh/bullmq` (docs.bullmq.io — Guide → Retrying failing jobs, Jobs → Job IDs, Removing jobs, Workers). Version `5.81.5` bundles `ioredis@5.11.1` as a regular dependency and declares `engines.node >= 12.22`. Maps to `phase-03-videos/TD-01` and `phase-03-videos/TD-11`.

### Job options that matter here (`DefaultJobOptions` / `BaseJobOptions`)

| Option | Meaning |
|--------|---------|
| `attempts` | Total number of attempts until the job completes (default `1`). `attempts: 3` = 1 run + 2 retries. |
| `backoff` | `number` (fixed ms) or `{ type: 'fixed' \| 'exponential', delay, jitter? }`. Exponential delay = `2^(attemptsMade-1) * delay` → with `delay: 5000`: 5s, 10s. |
| `jobId` | Overrides the auto-increment id. Adding a job whose id already exists in the queue is a no-op (dedup). Must not contain `:` and must not be all digits — use `video-<uuid>`. Removed jobs (`removeOnComplete`/`removeOnFail`) no longer block re-adding the same id. |
| `removeOnComplete` / `removeOnFail` | `boolean \| number \| { age?, count? }`. Default keeps jobs in the completed/failed sets. Eviction by `age`/`count` is best-effort, evaluated when another job finishes. |
| `delay`, `priority`, `lifo` | Not used in this phase. |

### Retry semantics

A job that throws is retried while `job.attemptsMade < job.opts.attempts`, waiting the backoff delay between attempts. After the last attempt it is moved to the **failed set** with `failedReason` and `stacktrace`. The `failed` worker event fires on every failed attempt (including intermediate ones) — to detect the terminal failure compare `job.attemptsMade >= (job.opts.attempts ?? 1)`.

### Worker options

| Option | Default | Notes |
|--------|---------|-------|
| `concurrency` | `1` | Jobs processed in parallel by one worker instance. |
| `lockDuration` | `30000` ms | Lock renewed automatically while `process()` runs; if the process dies the stalled checker re-queues the job. |
| `stalledInterval` | `30000` ms | Stalled check frequency. |
| `maxStalledCount` | `1` | Times a stalled job is recovered before being failed. |

Workers are at-least-once: a stalled or crashed job is re-delivered, so the processor must be idempotent (re-probing and overwriting the thumbnail is safe).

### Inspecting the queue

`queue.getJob(id)`, `queue.getJobs(['waiting','active','delayed','completed','failed'])`, `queue.getJobCounts()`, `queue.obliterate({ force: true })` (test cleanup), `queue.close()`.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (S3 client reference + Amazon S3 User Guide → multipart upload). Version `3.1146.0`, `engines.node >= 20`. Maps to `phase-03-videos/TD-02`, `TD-03`, `TD-05`, `TD-08`, `TD-12`.

### Client for an S3-compatible endpoint (MinIO)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  region: storage.region,
  endpoint: storage.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
});
```

`forcePathStyle: true` is mandatory for MinIO (`http://minio:9000/<bucket>/<key>` instead of virtual-hosted buckets). Presigned URLs embed the client's `endpoint` host in the SigV4 signature — a URL signed against `http://minio:9000` is invalid if the browser rewrites it to `http://localhost:9000`. Keep **two clients**: one on the internal endpoint for server/worker calls and one on the public endpoint (`S3_PUBLIC_ENDPOINT`) used only to presign URLs handed to browsers.

### Commands used in this phase (inputs → outputs)

| Command | Key input | Output |
|---------|-----------|--------|
| `HeadBucketCommand({ Bucket })` | — | resolves if the bucket exists; throws `NotFound` (`$metadata.httpStatusCode: 404`) otherwise |
| `CreateBucketCommand({ Bucket })` | — | creates the bucket (`BucketAlreadyOwnedByYou` on race) |
| `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` | — | `{ UploadId, Key, Bucket }` |
| `UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` | presigned only (body is sent by the client) | response header `ETag` per part |
| `ListPartsCommand({ Bucket, Key, UploadId, MaxParts?, PartNumberMarker? })` | — | `{ Parts: [{ PartNumber, ETag, Size }], IsTruncated, NextPartNumberMarker }` (max 1000 per page) |
| `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` | parts ascending by `PartNumber` | `{ Location, Key, ETag }`; errors `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` (part < 5 MiB except the last), `NoSuchUpload` |
| `AbortMultipartUploadCommand({ Bucket, Key, UploadId })` | — | frees uploaded parts |
| `HeadObjectCommand({ Bucket, Key })` | — | `{ ContentLength, ContentType, ETag }`; `NotFound` when missing |
| `GetObjectCommand({ Bucket, Key, Range?, ResponseContentDisposition?, ResponseContentType? })` | presigned for playback/download | storage answers `206 Partial Content` + `Content-Range` to `Range` requests |
| `PutObjectCommand({ Bucket, Key, Body, ContentType, ContentLength })` | thumbnail buffer | `{ ETag }` |
| `DeleteObjectCommand({ Bucket, Key })` / `ListObjectsV2Command({ Bucket, Prefix })` | cleanup by `videos/{id}/` prefix | — |

### Multipart limits (Amazon S3 User Guide → multipart upload limits)

- Part size 5 MiB – 5 GiB (no minimum for the last part); part numbers 1–10,000; max 10,000 parts; single `PutObject` max 5 GiB → objects > 5 GiB **require** multipart.
- Parts may be uploaded in any order and in parallel; re-uploading a part number overwrites it; each `UploadPart` response carries the `ETag` the client must echo on complete.
- Parts of an in-progress upload are billed/stored until `Complete` or `Abort` — abort abandoned uploads.
- Error-class names are exposed as `error.name` (`NotFound`, `NoSuchKey`, `NoSuchUpload`, `InvalidPart`, …) and `$metadata.httpStatusCode`.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (package `@aws-sdk/s3-request-presigner`). Version `3.1146.0` — always install in the same version as `@aws-sdk/client-s3`. Maps to `phase-03-videos/TD-02`, `TD-08`, `TD-10`, `TD-12`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const partUrl = await getSignedUrl(
  publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

const downloadUrl = await getSignedUrl(
  publicClient,
  new GetObjectCommand({
    Bucket,
    Key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  }),
  { expiresIn: 3600 },
);
```

- Signature: `getSignedUrl(client, command, options?: RequestPresigningArguments): Promise<string>`; `expiresIn` is in seconds (default 900, S3 max 7 days with IAM user credentials).
- The signed URL is bound to the HTTP method, host, path, query (`partNumber`, `uploadId`, `response-content-disposition`, …) and expiry; it carries no body constraint, so `UploadPart` URLs accept any payload size the client sends — the server enforces size after `Complete` via `HeadObject`.
- `ResponseContentDisposition` / `ResponseContentType` are query overrides honoured by S3 and MinIO on `GetObject` — they are part of the signed query string.
- A `Range` header is **not** signed into the URL: the browser/video element adds it per request and the storage answers `206`, so a single presigned `GetObject` URL serves the whole playback session until it expires.
