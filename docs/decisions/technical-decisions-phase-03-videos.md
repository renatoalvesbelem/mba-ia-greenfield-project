---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-03
scope_description: "Backend da Fase 03: fila de processamento, estratégia de upload direto ao object storage (até 10GB), cliente S3 e layout de buckets, worker de vídeo com FFmpeg, identificador público único, streaming/download e ciclo de status do vídeo."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend que entrega o módulo de vídeos (pré-cadastro, upload multipart pré-assinado, enfileiramento), a infraestrutura nova no Compose (object storage, broker da fila, worker) e o worker de processamento (FFmpeg). Todas as TDs deste documento incidem aqui.
- `next-frontend/` — Frontend deferred: a interface de upload/reprodução não faz parte desta fase. As TDs `Cross-layer` (TD-02, TD-10) fixam o contrato HTTP que o frontend vai consumir quando a UI de vídeo for planejada; nenhuma decisão aberta de frontend neste documento.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O `project-plan.md` e o diagrama C4 deixam a fila como "TBD". A API precisa publicar um job por vídeo após o upload e um worker separado precisa consumi-lo com retries, visibilidade de falha e idempotência. A escolha define uma peça nova de infraestrutura no `compose.yaml` e a biblioteca de integração no NestJS 11 (`@nestjs/core ^11.0.1` instalado). Depende de TD-06 (topologia do worker) para a forma de consumo.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila baseada em Redis com integração oficial do NestJS (`BullModule.forRootAsync`, `@InjectQueue`, `@Processor` + `WorkerHost`). Jobs têm `attempts`, `backoff` (fixed/exponential), `jobId` customizado para deduplicação, eventos `completed`/`failed` e conjunto de jobs falhos inspecionável.
- **Pros:** Retries/backoff, deduplicação e DLQ (failed set) prontos; integração NestJS oficial e documentada; Redis é um único container leve (`redis:7-alpine`) e serve futuramente para cache/rate-limit distribuído; `@nestjs/bullmq@11.x` suporta `bullmq ^5 || ^6` e `@nestjs/core ^11`.
- **Cons:** Adiciona Redis à stack (mais um serviço para operar); semântica at-least-once exige worker idempotente; o conjunto de jobs cresce se `removeOnComplete`/`removeOnFail` não forem configurados.

### Option B: RabbitMQ (`@nestjs/microservices`, transporte RMQ)
- Broker AMQP com `Transport.RMQ`, `@EventPattern`/`@MessagePattern`, `noAck: false` para ack manual e `prefetchCount`.
- **Pros:** Broker dedicado, durabilidade e roteamento maduros; modelo pub/sub flexível para cenários futuros multi-consumidor.
- **Cons:** Sem retry/backoff nativos no transporte NestJS (precisa de dead-letter exchanges e TTL configurados à mão); container mais pesado (Erlang + management UI); o `@nestjs/microservices` força um segundo "app" de microserviço mesmo para um único consumidor interno.

### Option C: Fila sobre PostgreSQL (`pg-boss`)
- Jobs em tabelas do próprio PostgreSQL 17 (`SKIP LOCKED`), retries e agendamento nativos; sem serviço novo.
- **Pros:** Zero infraestrutura nova — reutiliza o banco já no Compose; transação do job e do domínio no mesmo banco (sem outbox).
- **Cons:** Sem módulo NestJS oficial (wiring manual de provider/lifecycle); polling no banco de domínio compete com a carga da API; menos conhecido pela equipe e pelo ecossistema Nest; o diagrama C4 prevê um container de fila separado.

### Option D: Apache Kafka
- Log distribuído particionado; consumidores por grupo.
- **Pros:** Escala massiva e replay de eventos.
- **Cons:** Overkill para uma fila de trabalho única; sem semântica de retry por mensagem; Kafka + ZooKeeper/KRaft é a opção mais pesada para rodar localmente.

**Recommendation:** **Option A (BullMQ + Redis)** — é a única opção com retry/backoff/deduplicação prontos e integração oficial do NestJS 11, com custo de infra mínimo (um container Redis). Fixar `@nestjs/bullmq@^11.0.5` (alinhado ao major do Nest instalado; o 12.x mira `@nestjs/core ^12`) e `bullmq@^5.81.x` (linha estável que empacota `ioredis`). pg-boss é a alternativa mais barata em infra, mas o diagrama C4 e o plano já preveem um container de fila e a integração Nest é artesanal.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^5.81.5`

---

## TD-02: Large File Upload Strategy (até 10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** O requisito é aceitar arquivos de até 10GB sem segurar a API durante o envio e permitir retomada em caso de falha de conexão (Pontos de Atenção do `project-plan.md`). O object storage é S3-compatível (TD-04/TD-05). A estratégia define o handshake entre cliente e API (contrato que o frontend consumirá em fase futura) e onde os bytes trafegam — por isso é cross-layer.

**Options:**

### Option A: Upload direto ao storage com S3 Multipart Upload pré-assinado
- A API cria o vídeo como rascunho e inicia um `CreateMultipartUpload`; devolve `upload_id`, tamanho de parte e quantidade de partes. O cliente pede URLs pré-assinadas de `UploadPart` (em lote), envia cada parte direto ao storage e, ao final, chama a API com a lista `{ part_number, etag }` para `CompleteMultipartUpload`. `ListParts` permite retomar (descobrir quais partes já subiram).
- **Pros:** Nenhum byte de vídeo passa pela API (event loop livre); partes paralelas e retomáveis por construção; limites S3 comportam 10GB com folga (partes de 5MiB–5GiB, até 10.000 partes); único caminho suportado pelo S3 real para objetos > 5GiB (PUT único é limitado a 5GiB).
- **Cons:** Handshake em várias etapas (init → part-urls → complete) que o cliente precisa orquestrar; a API precisa expor dois endpoints de storage (interno para o servidor, público para o navegador assinar URLs com o host correto); uploads abandonados deixam partes órfãs até `AbortMultipartUpload`/lifecycle.

### Option B: PUT único pré-assinado (`PutObject`)
- A API gera uma URL pré-assinada de `PutObject`; o cliente envia o arquivo inteiro em uma requisição.
- **Pros:** Um só passo; implementação trivial.
- **Cons:** Sem retomada (falha reinicia 10GB do zero); S3 limita PUT único a 5GiB — não atende o requisito de 10GB em produção; sem paralelismo.

### Option C: Protocolo tus (resumable upload) com servidor tus na API
- Servidor tus (`@tus/server`) montado na API; cliente envia `PATCH` com `Upload-Offset`; o servidor grava no storage via `@tus/s3-store`.
- **Pros:** Protocolo aberto e padronizado para retomada; clientes prontos (tus-js-client).
- **Cons:** Os bytes trafegam pela API (viola o requisito de não segurar a API); exige um handler HTTP fora do ciclo Nest/Express padrão e lock store; dependência pesada para um único caso de uso.

### Option D: Streaming multipart/form-data pela API (`busboy`/`multer` → S3 `Upload`)
- A API recebe `multipart/form-data` e repassa o stream ao storage.
- **Pros:** Modelo tradicional, um endpoint só.
- **Cons:** 10GB passando pelo processo Node (CPU, rede e timeouts de proxy); sem retomada; impossível escalar sem afetar a API — exatamente o anti-padrão que a fase quer evitar.

**Recommendation:** **Option A (Multipart pré-assinado direto ao storage)** — é a única opção que satisfaz simultaneamente "10GB sem travar a API", retomada e compatibilidade com o S3 real; o diagrama C4 já prevê `API → storage (Uploads)` apenas como orquestração. O pré-cadastro como rascunho acontece na chamada de init — o vídeo nasce `draft` antes de qualquer byte subir.

**Decision:** A (S3 Multipart Upload pré-assinado direto ao storage)

---

## TD-03: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O storage é S3-compatível (MinIO local, S3 em produção). A biblioteca cliente precisa suportar multipart upload, URLs pré-assinadas (`UploadPart`, `GetObject` com `ResponseContentDisposition`), `HeadObject`/`ListParts`/`AbortMultipartUpload` e endpoint customizado com path-style. Node 25 no container (`node:25.6.0-slim`).

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- SDK oficial e modular: `S3Client({ endpoint, forcePathStyle: true, region, credentials })` + comandos por operação; `getSignedUrl(client, command, { expiresIn })` assina qualquer comando.
- **Pros:** Vendor-neutro entre MinIO e S3 real (mesmo código, só muda `endpoint`); cobre todas as operações necessárias; tipagem completa; `engines.node >= 20` (compatível com Node 25); a assinatura usa o `endpoint` do client, o que permite um client dedicado ao endpoint público para pré-assinar.
- **Cons:** API verbosa (um Command por chamada); dependência pesada em número de pacotes transitivos (`@smithy/*`); duas libs para instalar.

### Option B: MinIO JavaScript SDK (`minio`)
- Cliente oficial MinIO com API simplificada (`presignedPutObject`, `presignedGetObject`, `fPutObject`).
- **Pros:** API curta; bom para MinIO.
- **Cons:** Acopla o código ao vendor cuja distribuição community foi descontinuada (TD-04); sem helpers de multipart pré-assinado por parte (precisa cair em chamadas de baixo nível); troca para S3 em produção vira risco.

### Option C: Chamadas HTTP SigV4 manuais
- Implementar assinatura e XML das operações multipart à mão.
- **Pros:** Zero dependências.
- **Cons:** Reimplementar SigV4 e o protocolo multipart é propenso a erro e sem valor para o projeto.

**Recommendation:** **Option A (AWS SDK v3)** — mantém o código portável entre MinIO e S3 e cobre multipart + presign de forma oficial. Fixar `@aws-sdk/client-s3@^3.1146.0` e `@aws-sdk/s3-request-presigner@^3.1146.0` (versões em paridade — os pacotes do SDK v3 são publicados juntos).

**Decision:** A (AWS SDK for JavaScript v3)
**Libraries:** `@aws-sdk/client-s3@^3.1146.0`, `@aws-sdk/s3-request-presigner@^3.1146.0`

---

## TD-04: Local S3-compatible Server Image for Docker Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O plano aponta MinIO como o S3 local em Docker, mas em 2025 o MinIO tornou a edição community "source-only": as imagens `minio/minio` e `minio/mc` foram removidas do Docker Hub (set/2026) e `quay.io/minio/minio` passou a responder 401 (verificado nesta pesquisa: `docker pull quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` → `401 UNAUTHORIZED`). O `compose.yaml` precisa de uma imagem pullável e reprodutível para o serviço de storage. A decisão é só da imagem do dev environment — a API continua falando S3 (TD-03).

**Options:**

### Option A: `bitnamilegacy/minio:2025.7.23` (Bitnami/Broadcom, repositório congelado)
- Último build community do MinIO publicado pela Bitnami antes do congelamento (`APP_VERSION=2025.7.23`, equivale a `RELEASE.2025-07-23`). Imagem com `mc` e `curl` embutidos, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `MINIO_DEFAULT_BUCKETS`, portas 9000 (API) e 9001 (console). Verificado pullável: `bitnamilegacy/minio@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7`.
- **Pros:** Publicada por um vendor conhecido (não por indivíduo); amplamente adotada como fallback (CI de projetos como uppy); traz `curl` para healthcheck e `mc` para bootstrap; continua sendo MinIO — mesma API que o plano prevê.
- **Cons:** Congelada — não recebe correções (não inclui o fix de CVE-2025-62506 de out/2025; aceitável para dev local, inaceitável para produção); data dir diferente do upstream (`/bitnami/minio/data`).

### Option B: Rebuild community de terceiros (`derklaro/minio`, `coollabsio/minio`)
- Imagens construídas automaticamente a partir das tags upstream por mantenedores independentes; incluem a `RELEASE.2025-10-15T17-29-55Z`.
- **Pros:** Versão mais recente (com o fix do CVE); drop-in do layout upstream (`/data`).
- **Cons:** Cadeia de suprimento de um indivíduo; sem garantia de permanência; `mc` não incluído.

### Option C: Build do MinIO a partir do fonte no próprio Compose
- `Dockerfile` multi-stage com `golang` fazendo `go build` da tag `RELEASE.2025-10-15T17-29-55Z` do repositório arquivado.
- **Pros:** Reprodutível e sem terceiros; versão escolhida livremente.
- **Cons:** Build de vários minutos e centenas de MB de toolchain Go só para subir o ambiente de dev; o repositório upstream está arquivado.

### Option D: Outro servidor S3-compatível (RustFS, Garage, SeaweedFS, LocalStack)
- Trocar o produto: RustFS (Rust, Apache-2.0, "MinIO alternative") ou similares.
- **Pros:** Projetos ativos; RustFS tem imagem oficial pullável e API S3.
- **Cons:** Sai do que o plano documenta (MinIO); maturidade/paridade S3 (multipart pré-assinado, `ResponseContentDisposition`) a validar; Garage exige configuração de layout de cluster; LocalStack é pesado.

**Recommendation:** **Option A (`bitnamilegacy/minio:2025.7.23` fixada por digest)** — preserva o MinIO previsto no plano com a cadeia de suprimento mais confiável disponível hoje, traz `curl`/`mc` para healthcheck e bootstrap e é adequada ao uso exclusivo em dev/test. Registrar o digest no `compose.yaml` e revisitar quando o projeto tiver produção (S3 real ou RustFS).

**Decision:** A (`bitnamilegacy/minio:2025.7.23`, fixada por digest `sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7`)

---

## TD-05: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Vídeos originais e thumbnails precisam de chaves de storage previsíveis, sem colisão, fáceis de limpar quando um vídeo é removido, e que não exponham dados do usuário. A API grava a chave na tabela de vídeos (`storage_key`, `thumbnail_key`) e o worker lê/escreve por essas chaves.

**Options:**

### Option A: Bucket único com prefixo por vídeo — `videos/{videoId}/original.{ext}` e `videos/{videoId}/thumbnail.jpg`
- Um bucket (`streamtube-videos`), todas as chaves de um vídeo sob o prefixo do seu `id` (UUID interno).
- **Pros:** Remoção/listagem por vídeo com um `ListObjects(prefix)`; sem colisão (UUID); bucket único simplifica credenciais, políticas e bootstrap; thumbnail e original ficam juntos.
- **Cons:** Um bucket para dois tipos de objeto (políticas de cache/ACL distintas exigem regra por prefixo).

### Option B: Dois buckets (`videos`, `thumbnails`)
- Separação física por tipo de objeto.
- **Pros:** Políticas de acesso/cache por bucket (thumbnails públicos, vídeos privados).
- **Cons:** Dobra o bootstrap e as credenciais; remoção de um vídeo toca dois buckets; prematuro para o escopo atual (ambos servidos por URL pré-assinada).

### Option C: Prefixo por canal — `channels/{channelId}/videos/{videoId}/...`
- Hierarquia espelhando o domínio.
- **Pros:** Listagem por canal direto no storage.
- **Cons:** Chave depende de relação de domínio (mover vídeo entre canais quebra a chave); a listagem por canal já vem do banco; mais longa sem ganho.

**Recommendation:** **Option A (bucket único, prefixo `videos/{videoId}/`)** — menor superfície operacional e remoção por prefixo; a extensão do original vem do nome do arquivo enviado e o thumbnail é sempre `thumbnail.jpg` (TD-07). Buckets separados podem ser introduzidos quando houver política de acesso distinta.

**Decision:** A (bucket único `streamtube-videos`, prefixo `videos/{videoId}/`)

---

## TD-06: Video Worker Runtime Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O diagrama C4 prevê um container "Video Worker (FFmpeg)" que consome a fila, lê/grava no storage e atualiza o banco. É preciso decidir onde o código do worker vive, como ele sobe no Compose e como atualiza o banco. Depende de TD-01.

**Options:**

### Option A: Mesmo codebase NestJS, entrypoint separado (`src/worker.ts` → `WorkerModule`) em container próprio
- Um segundo bootstrap (`NestFactory.createApplicationContext(WorkerModule)`) que registra só o processador BullMQ, o storage e o TypeORM; serviço `video-worker` no Compose com a mesma imagem de dev (Node + FFmpeg) e comando próprio; o worker atualiza a tabela de vídeos diretamente via TypeORM (como no C4).
- **Pros:** Reusa entidades, config, storage e DI do projeto; CPU do FFmpeg isolada do processo da API; escala horizontal subindo réplicas do serviço; um só `tsc`/lint/test.
- **Cons:** Dois processos compartilhando um pacote (atenção a imports para não carregar controllers no worker); a imagem de dev precisa do FFmpeg mesmo para a API.

### Option B: Processador BullMQ dentro do processo da API
- `@Processor` registrado no `AppModule`.
- **Pros:** Zero infra adicional; mais simples de rodar.
- **Cons:** FFmpeg e API disputam CPU e memória no mesmo container — viola "sem impacto na performance"; escalar o processamento obriga a escalar a API; foge do C4.

### Option C: Worker em serviço independente (outro repositório/linguagem, ex.: Python ou Go)
- Serviço separado consumindo a mesma fila.
- **Pros:** Liberdade de stack para mídia.
- **Cons:** Duplica modelo de dados/config e CI; contrato de fila vira integração entre repos; custo desproporcional para extrair metadados e um frame.

**Recommendation:** **Option A (mesmo codebase, entrypoint e container próprios)** — isola a carga do FFmpeg, respeita o C4 (worker lê/grava storage e atualiza o banco) e mantém um único projeto testável. A imagem de dev compartilhada (com FFmpeg) também permite que os testes de integração do processador rodem no container da API, conforme a convenção do projeto de rodar tudo em `nestjs-api`.

**Decision:** A (mesmo codebase NestJS, entrypoint `src/worker.ts` e serviço `video-worker` no Compose)

---

## TD-07: Metadata Extraction and Thumbnail Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa extrair duração e metadados (resolução, codec, bitrate, container) e gerar um thumbnail a partir de um frame. O C4 fixa FFmpeg como ferramenta; resta decidir como invocá-lo a partir do Node e o formato do thumbnail.

**Options:**

### Option A: Binários `ffprobe`/`ffmpeg` via `child_process.execFile` (sem wrapper)
- `ffprobe -v error -print_format json -show_format -show_streams <input>` para metadados; `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale=640:-2 -f image2 -c:v mjpeg pipe:1` para o frame em JPEG escrito no stdout.
- **Pros:** Zero dependência npm; saída JSON tipável; controle total de argumentos, timeouts e `AbortSignal`; FFmpeg instalado na imagem via `apt`.
- **Cons:** Montar argumentos à mão; parse do JSON do ffprobe é responsabilidade nossa.

### Option B: `fluent-ffmpeg`
- Wrapper fluente clássico (`ffmpeg(input).screenshots(...)`, `ffprobe(input, cb)`).
- **Pros:** API conveniente e muito usada historicamente.
- **Cons:** Pacote marcado como **deprecated** no npm ("Package no longer supported", última versão 2.1.3); API baseada em callbacks/eventos sem tipos oficiais; adiciona dependência morta em projeto greenfield.

### Option C: FFmpeg em WebAssembly (`@ffmpeg/ffmpeg`)
- FFmpeg compilado para WASM rodando em Node.
- **Pros:** Sem binário nativo na imagem.
- **Cons:** Ordens de grandeza mais lento, carrega o arquivo em memória (impraticável para 10GB), limites de 2GB do WASM.

**Recommendation:** **Option A (binários via `child_process`)** — é a opção sem dependência, com saída JSON estável e sem o risco de um wrapper descontinuado. Thumbnail em JPEG com 640px de largura (altura proporcional) capturado em `t = min(10% da duração, 10s)`, sempre gravado como `thumbnail.jpg` (TD-05).

**Decision:** A (`ffprobe`/`ffmpeg` via `child_process`; thumbnail JPEG 640px em `min(10% da duração, 10s)`)

---

## TD-08: Worker Input Access Strategy

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O worker precisa alimentar o FFmpeg com um objeto de até 10GB que está no storage. Baixar o arquivo inteiro para disco local do worker multiplica o custo em tempo, I/O e espaço. Depende de TD-03 (presign) e TD-07.

**Options:**

### Option A: FFmpeg lê direto do storage por URL pré-assinada (HTTP com range)
- O worker gera uma URL `GetObject` pré-assinada (endpoint interno `minio:9000`) e passa como input; o protocolo `http` do FFmpeg é seekable (`seekable=1`) e usa range requests, então `ffprobe` lê só cabeçalhos/índices e `ffmpeg -ss` busca o frame sem percorrer o arquivo. O thumbnail sai em `pipe:1` e vai para o storage via `PutObject`.
- **Pros:** Nenhum byte do vídeo tocando o disco do worker; tempo de processamento proporcional ao necessário, não ao tamanho do arquivo; sem limpeza de temporários.
- **Cons:** Depende de o container ter índice acessível por seek (MP4 com `moov` no fim exige leituras extras, mas ainda via range); erro de rede vira falha de job (coberto pelos retries de TD-11).

### Option B: Download completo para `tmp` e processamento local
- `GetObject` → arquivo temporário → FFmpeg → remoção.
- **Pros:** Fluxo mais previsível; funciona com qualquer container.
- **Cons:** 10GB de I/O por job; precisa de disco e limpeza; tempo e custo dominados pela cópia.

### Option C: Stream do `GetObject` para o stdin do FFmpeg
- `Body` do SDK encanado em `pipe:0`.
- **Pros:** Sem disco.
- **Cons:** stdin não é seekable — `ffprobe` e `-ss` precisam ler o arquivo todo até o ponto desejado; MP4 com `moov` no fim não é probeável por pipe.

**Recommendation:** **Option A (leitura por URL pré-assinada com range)** — explora o seek nativo do FFmpeg e mantém o worker sem estado em disco; os retries da fila cobrem falhas transitórias de rede. O worker usa o endpoint interno do storage (não o público) para assinar essas URLs.

**Decision:** A (FFmpeg lê o objeto por URL pré-assinada do endpoint interno, com HTTP range)

---

## TD-09: Public Video Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de um identificador curto e único para a URL pública (ex.: `/watch/{id}`), que não conflite com outros vídeos nem exponha a sequência interna. A chave primária interna continua UUID (convenção das entidades do projeto). A escolha afeta a coluna da entidade, o índice único e os endpoints públicos.

**Options:**

### Option A: ID aleatório URL-safe de 11 caracteres gerado com `crypto` (alfabeto `A-Za-z0-9_-`) + índice único + retry em colisão
- `crypto.randomBytes` mapeado para o alfabeto de 64 símbolos (66 bits de entropia, mesmo formato do YouTube); `UNIQUE` na coluna; em violação `23505` gera outro id (padrão já usado para `nickname` em `ChannelsService`).
- **Pros:** Zero dependência; curto e legível; não enumerável; colisão estatisticamente desprezível e ainda assim tratada.
- **Cons:** ~15 linhas de utilitário próprio para testar.

### Option B: `nanoid`
- Biblioteca de referência para IDs aleatórios URL-safe.
- **Pros:** Amplamente usada; mesmo formato da Option A.
- **Cons:** Versões atuais (`nanoid@6`, `type: module`) são **ESM-only**; o projeto compila para CommonJS e o Jest (ts-jest) não resolve pacotes ESM sem `transformIgnorePatterns` — fricção desnecessária para um gerador trivial; a linha CJS (`3.x`) está em manutenção mínima.

### Option C: UUID v4 na URL
- Reusar o `id` interno como identificador público.
- **Pros:** Nada a gerar.
- **Cons:** 36 caracteres na URL; expõe o PK interno; o plano pede "URL curta".

### Option D: ID sequencial codificado (Hashids/Sqids)
- Encodar o `serial` numa string curta.
- **Pros:** Compacto e determinístico.
- **Cons:** Enumerável/decodificável (não é segurança, mas vaza volume de uploads); exige coluna sequencial extra.

**Recommendation:** **Option A (gerador próprio com `crypto` + unique + retry)** — entrega o formato desejado sem dependência nem fricção ESM/CJS, e reaproveita o padrão de retry em `23505` já existente no projeto.

**Decision:** A (`public_id` de 11 caracteres via `crypto.randomBytes`, alfabeto `A-Za-z0-9_-`, unique + retry em `23505`)

---

## TD-10: Playback Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A reprodução deve começar sem baixar o arquivo inteiro (range requests / `206 Partial Content`) e o usuário precisa poder baixar o vídeo. O diagrama C4 mostra o frontend fazendo "Streams" direto do Object Storage. A decisão define o contrato dos endpoints de playback/download e quem serve os bytes — cross-layer porque o player e o botão de download do frontend (Fase 05) dependem dela.

**Options:**

### Option A: API responde `302 Found` para URL pré-assinada `GetObject`; o storage serve os bytes com range
- `GET /videos/{publicId}/stream` → 302 para URL pré-assinada curta (TTL em TD-12); o storage S3/MinIO responde `206` a `Range`. Download: mesmo mecanismo com `ResponseContentDisposition: attachment; filename="..."`. Bucket permanece privado.
- **Pros:** API fora do caminho dos bytes (coerente com C4 e com o requisito de performance); `Range`/`206`, `ETag` e `Accept-Ranges` nativos do storage; download é só um parâmetro de presign; URL expira (controle de acesso mantido na API).
- **Cons:** Exige endpoint público do storage acessível pelo navegador (host diferente do interno — dois `S3Client`s); a URL final muda a cada chamada (cache do navegador menos efetivo); redirecionamento é visível ao cliente.

### Option B: API faz proxy dos bytes com suporte a `Range`
- `GET /videos/{publicId}/stream` lê `Range`, chama `GetObject` com o mesmo header e devolve `206` + `Content-Range`.
- **Pros:** URL estável e mesma origem; bucket 100% interno; controle fino de headers.
- **Cons:** Todos os bytes de vídeo passam pela API (memória/CPU/rede proporcionais à audiência) — o mesmo problema que o upload evita; precisa reimplementar semântica de range/HEAD/ETag.

### Option C: Bucket público com URL estática
- Objetos legíveis anonimamente; a API só devolve a URL.
- **Pros:** Mais simples; cacheável.
- **Cons:** Perde o controle de acesso (vídeos `draft`/`failed` e, na Fase 04, `unlisted` ficariam acessíveis por quem adivinhar a chave); irreversível sem migração de ACL.

**Recommendation:** **Option A (302 para URL pré-assinada, range servido pelo storage)** — é o desenho do C4, mantém a API leve e o bucket privado; download reutiliza a mesma rota com `Content-Disposition`. O endpoint público do storage (`S3_PUBLIC_ENDPOINT`) é usado só para assinar URLs voltadas ao navegador; operações do servidor e do worker usam o endpoint interno.

**Decision:** A (`302 Found` para URL pré-assinada `GetObject`; download via `ResponseContentDisposition`)

---

## TD-11: Video Status Lifecycle and Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O plano exige refletir no banco o ciclo "rascunho → processando → pronto/erro" e definir o que acontece quando o processamento falha. A Fase 04 introduzirá visibilidade e o fluxo "rascunho → publicação" como conceito de publicação; o estado desta fase precisa ser o do pipeline de upload/processamento sem colidir com aquele. Depende de TD-01 (retries da fila).

**Options:**

### Option A: Enum único `status` com 4 estados + retries da fila + estado terminal `failed` reprocessável
- `draft` (criado no init do upload) → `processing` (ao completar o multipart e enfileirar) → `ready` (worker gravou duração/metadados/thumbnail) ou `failed` (job esgotou as tentativas; `processing_error` guarda o motivo). Fila com `attempts: 3`, `backoff` exponencial, `jobId = video-{id}` (idempotência). O dono pode reenfileirar um vídeo `failed`. Visibilidade/publicação (Fase 04) será coluna separada.
- **Pros:** Enum pequeno e observável; falhas transitórias resolvidas pela fila sem intervenção; erro persistido para diagnóstico; não acopla com publicação.
- **Cons:** Não distingue "upload em andamento" de "upload nunca começou" (ambos `draft`); rascunhos abandonados precisam de limpeza futura (fora do escopo).

### Option B: Estados granulares (`draft`, `uploading`, `uploaded`, `processing`, `ready`, `failed`)
- Transição a cada etapa do multipart.
- **Pros:** Mais observabilidade do upload.
- **Cons:** A API não vê as partes subindo (vão direto ao storage) — `uploading` seria inferido; mais transições para testar sem ganho funcional nesta fase.

### Option C: Duas colunas — `upload_status` e `processing_status`
- Separar as duas máquinas de estado.
- **Pros:** Modela precisamente upload × processamento.
- **Cons:** Consultas e contratos ficam com dois campos para um conceito que o plano descreve como um só; complexidade prematura.

**Recommendation:** **Option A (enum único `draft → processing → ready | failed`)** — espelha exatamente o ciclo do plano, deixa o retry para a fila (TD-01) e preserva o erro para diagnóstico; a reprocessagem manual pelo dono dá saída para o estado terminal. Publicação/visibilidade ficam para a Fase 04 em coluna própria.

**Decision:** A (enum `status`: `draft → processing → ready | failed`; `attempts: 3` com backoff exponencial; `processing_error`; reprocessamento pelo dono)

---

## TD-12: Upload Limits and Presigned URL Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O multipart pré-assinado (TD-02) precisa de parâmetros fixos e compartilhados entre a validação da API (Joi + DTOs), o `.env`/Compose e o contrato devolvido ao cliente: tamanho máximo, tamanho da parte, tipos aceitos e validade das URLs. Limites S3: partes de 5MiB a 5GiB, máximo de 10.000 partes.

**Options:**

### Option A: 10GiB máximo, partes fixas de 64MiB, tipos de vídeo em allowlist, URLs de parte com 1h e de playback/download com 1h — tudo configurável por env com esses defaults
- `UPLOAD_MAX_SIZE_BYTES=10737418240`, `UPLOAD_PART_SIZE_BYTES=67108864` (10GiB → 160 partes), `UPLOAD_PART_URL_TTL_SECONDS=3600`, `PLAYBACK_URL_TTL_SECONDS=3600`; tipos aceitos `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`; tamanho declarado no init é conferido com `HeadObject` após o complete.
- **Pros:** Poucas partes (menos round-trips) com retomada em granularidade razoável; limites explícitos no contrato; defaults seguros e ajustáveis sem código.
- **Cons:** 64MiB por parte exige buffer desse tamanho no cliente; TTL de 1h pode expirar em uploads muito lentos (cliente pede novas URLs — suportado).

### Option B: Partes pequenas (8MiB) e TTL curto (15min)
- Mais partes (1.280 para 10GiB) e URLs de vida curta.
- **Pros:** Retomada mais fina; janela de exposição menor.
- **Cons:** 1.280 requisições de presign/upload; mais chamadas à API para renovar URLs; `CompleteMultipartUpload` com lista grande.

### Option C: Sem allowlist de tipo e sem verificação de tamanho pós-upload
- Aceitar qualquer `content_type` e confiar no `size_bytes` declarado.
- **Pros:** Menos validação.
- **Cons:** Permite subir arquivos não-vídeo que só falham no worker; tamanho declarado pode mentir e furar o limite de 10GB.

**Recommendation:** **Option A (10GiB / partes de 64MiB / allowlist / TTL 1h, configuráveis)** — equilibra número de partes, retomada e simplicidade; a conferência via `HeadObject` fecha o limite de 10GB no lado do servidor. Valores vivem em um namespace de config próprio e são validados pelo schema Joi.

**Decision:** A (10 GiB máx., partes de 64 MiB, allowlist `video/mp4|webm|quicktime|x-matroska`, TTL 1h para partes e playback — configuráveis por env)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ + Redis (`@nestjs/bullmq`) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | Large File Upload Strategy (até 10GB) | S3 Multipart pré-assinado direto ao storage | A (Multipart pré-assinado) |
| TD-03 | Backend | S3 Client Library | AWS SDK v3 (`@aws-sdk/client-s3` + presigner) | A (AWS SDK v3) |
| TD-04 | Repo-wide | Local S3-compatible Server Image | `bitnamilegacy/minio:2025.7.23` fixada por digest | A (`bitnamilegacy/minio:2025.7.23`) |
| TD-05 | Backend | Bucket and Object Key Layout | Bucket único, prefixo `videos/{videoId}/` | A (bucket único, prefixo por vídeo) |
| TD-06 | Backend | Video Worker Runtime Topology | Mesmo codebase, entrypoint e container próprios | A (mesmo codebase, container próprio) |
| TD-07 | Backend | Metadata Extraction and Thumbnail Tooling | `ffprobe`/`ffmpeg` via `child_process` | A (`ffprobe`/`ffmpeg` via `child_process`) |
| TD-08 | Backend | Worker Input Access Strategy | FFmpeg lê por URL pré-assinada (HTTP range) | A (URL pré-assinada com range) |
| TD-09 | Backend | Public Video Identifier Strategy | ID aleatório de 11 chars via `crypto` + unique + retry | A (`crypto` + unique + retry) |
| TD-10 | Cross-layer | Playback Streaming and Download Delivery | 302 para URL pré-assinada; range servido pelo storage | A (302 para URL pré-assinada) |
| TD-11 | Backend | Video Status Lifecycle and Failure Handling | `draft → processing → ready \| failed` + retries + reprocess | A (`draft → processing → ready \| failed`) |
| TD-12 | Backend | Upload Limits and Presigned URL Policy | 10GiB / 64MiB / allowlist / TTL 1h configuráveis | A (10GiB / 64MiB / allowlist / TTL 1h) |
