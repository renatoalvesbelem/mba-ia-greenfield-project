---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-03T15:00:04-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-03T14:56:11-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Download pelo usuário não define se o acesso anônimo pode baixar"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Pré-cadastro como rascunho não define os dados mínimos do rascunho (título)"
    resolved_by: clarification
  - id: DG-1
    status: resolved
    summary: "Vídeo pertence ao canal, mas a Fase 02 não expõe lookup de canal por usuário"
    resolved_by: clarification
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Large File Upload Strategy (até 10GB)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — S3 Client Library"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Local S3-compatible Server Image for Docker Compose"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Bucket and Object Key Layout"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Video Worker Runtime Topology"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Metadata Extraction and Thumbnail Tooling"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Worker Input Access Strategy"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Public Video Identifier Strategy"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Playback Streaming and Download Delivery"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Video Status Lifecycle and Processing Failure Handling"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Upload Limits and Presigned URL Policy"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **AMB-1** _(resolved_by clarification)_ — "Download do vídeo pelo usuário" não dizia se o download exige autenticação. Clarificado: download segue a mesma política do streaming — qualquer visitante (anônimo ou autenticado) baixa vídeos com `status = ready`; a Fase 05 já prevê "Botão de download" ao lado de "Acesso anônimo à visualização". Contrato fixado em `phase-03-videos/TD-10`.
- **AMB-2** _(resolved_by clarification)_ — "Pré-cadastro automático do vídeo como rascunho" não dizia quais dados o rascunho carrega. Clarificado: o init do upload exige `filename`, `content_type` e `size_bytes`; `title` é opcional e, quando ausente, assume o nome do arquivo sem extensão. Edição de título/descrição/categoria fica na Fase 04. Refletido em `phase-03-videos/TD-11`.
- **DG-1** _(resolved_by clarification)_ — Vídeos pertencem ao canal 1:1 do usuário, mas `ChannelsService` (Fase 02) só expõe `createChannel`. Clarificado: a Fase 03 adiciona `ChannelsService.findByUserId(userId)` dentro do `ChannelsModule` (o domínio de canais continua dono da consulta); `VideosService` resolve o canal do `JwtPayload.sub` por essa chamada. Sem TD novo — é extensão do módulo existente.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decidido: A (BullMQ + Redis via `@nestjs/bullmq`).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decidido: A (S3 Multipart Upload pré-assinado direto ao storage).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decidido: A (AWS SDK for JavaScript v3).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decidido: A (`bitnamilegacy/minio:2025.7.23` fixada por digest).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decidido: A (bucket único `streamtube-videos`, prefixo `videos/{videoId}/`).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decidido: A (mesmo codebase, entrypoint `src/worker.ts` e serviço `video-worker`).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decidido: A (`ffprobe`/`ffmpeg` via `child_process`, thumbnail JPEG 640px).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decidido: A (FFmpeg lê por URL pré-assinada do endpoint interno, com range).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decidido: A (`public_id` de 11 caracteres via `crypto`, unique + retry).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decidido: A (`302` para URL pré-assinada; download via `ResponseContentDisposition`).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decidido: A (`draft → processing → ready | failed`, 3 tentativas com backoff exponencial, `processing_error`, reprocessamento pelo dono).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decidido: A (10 GiB / partes de 64 MiB / allowlist de tipos / TTL 1h, configuráveis por env).
