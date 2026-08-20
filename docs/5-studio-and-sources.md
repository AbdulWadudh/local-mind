# Studio & Data Sources

Two additions that turn the four-stage library into something you install and
operate: **data sources** (get real systems into the corpus) and **the Studio**
(a mountable UI for managing and querying it).

```bash
bun run studio          # API + prebuilt UI on http://localhost:4141
bun run studio:dev      # Vite HMR on :5273, proxying /api to :4141
bun run studio:api      # API only
```

---

## 1. Using LocalMind as a library

```bash
bun add localmind
```

Four subpath exports, so heavy dependencies stay optional:

| Import | Contains |
|---|---|
| `localmind` | The `LocalMind` facade plus every stage primitive |
| `localmind/sources` | GitHub analyzer + nine service connectors |
| `localmind/studio` | `createStudioRouter()` and the prebuilt SPA |
| `localmind/protocol` | The Studio wire types, shared by server and UI |
| `localmind/testing` | Deterministic hashing embedder + assertion harness |

```ts
import { LocalMind } from 'localmind';
import { githubSource, postgresSource } from 'localmind/sources';

const mind = await LocalMind.open();

await mind.ingestSource(githubSource({ repo: 'your-org/orders-api' }));
await mind.ingestSource(postgresSource({ url: process.env.DATABASE_URL! }));

const result = await mind.research('where is refund state stored?');
console.log(result.answer, result.verification.grounded);
```

Per-tenant isolation is a config overlay, shallow-merged per section:

```ts
const mind = await LocalMind.open({ config: { store: { tableName: `t_${tenantId}` } } });
```

### One non-obvious thing the facade handles

A LanceDB `Table` handle points at a dataset *version*. A handle opened before a
write does not necessarily observe that write — which in a long-lived server
shows up as "I added a document and the very next question could not find it".

`LocalMind` tags its cached retriever with a generation counter and bumps it on
every mutation, so the next query reopens. And both stores catch the
stale-handle error class and call `checkoutLatest()` before retrying once, which
covers the other direction: `localmind ingest --rebuild` from a terminal while
the Studio is running. Neither is visible in a CLI; both matter in a server.

---

## 2. Data sources

A source turns *something that is not documents* into documents. It never
embeds, never chunks, never touches the vector store. That is what lets a
repository, a Postgres schema and a hand-typed note flow through one ingest path
with identical guarantees.

```ts
interface DataSource {
  readonly kind: string;
  readonly ref: string;   // idempotency key
  readonly label: string;
  collect(context: SourceContext): Promise<SourceCollectResult>;
}
```

**`ref` is the idempotency key.** `ingestSource` deletes every document from the
previous run of that ref before writing the new ones, so re-syncing is a clean
swap rather than an accumulation of stale duplicates. Verified: re-running the
Postgres connector reports `documents=5 replaced=5`.

### The GitHub analyzer

`git clone --depth 1` into a temp directory (removed in a `finally`, including on
failure), then a filtered walk. `owner/name`, a URL, an SSH remote, or `path:` for
a local checkout you already have. Private repos take a `token`, used for the
clone URL only.

The file filter is aggressive on purpose: the budget is the model's context
window, not the disk. Lockfiles, snapshots, build output, vendored code, binaries
and fixtures are skipped; manifests are always read whole.

**Two classes of document, and the distinction matters.**

*Deterministic* documents are transcriptions — repository structure, the
dependency inventory, the configuration surface, detected services, and the
project's own README verbatim. Free, exact, cannot hallucinate. Most of the
practical value is here.

*Synthesised* documents are summaries — "what this project does", "architecture
and data flow" with a Mermaid component diagram. These need a model, so they are
the only part that can be wrong. They are labelled as synthesised in their own
text, and they degrade to **absent** rather than to wrong: if the model call
fails, the deterministic documents still ship and the repo stays searchable.
`skipSynthesis: true` opts out entirely at zero model cost.

Observed on `honojs/hono`: 431 indexed files, 49 dependencies, 9 deterministic
documents, no clone left behind.

### Service detection

Deterministic — no model. Four independent signals, and confidence is a function
of how many agree:

| Signal | Source | Weight |
|---|---|---|
| Dependency | `package.json`, `requirements.txt`, `go.mod`, `pom.xml`, … | strongest — a dependency is a compile-time commitment |
| Container / IaC | `docker-compose.yml` images, Terraform resource types | tells you what runs alongside |
| Environment | `.env.example`, plus `process.env.X` / `os.getenv` reads | names the credential the connector needs |
| Schema artefact | `openapi.yaml`, `*.graphql`, `schema.prisma` | exact |

Confidence drives the UI: `high` is offered as "connect this", `low` as "we think
you might use this". Guessing loudly is worse than guessing tentatively.

Verified against a service with all four markers:

```
[high] postgres  connector  · dependency "drizzle-orm" in package.json
                            · dependency "postgres" in package.json
                            · container "postgres:16-alpine" in docker-compose.yml
                            env: DATABASE_URL
[high] redis     connector  · dependency "ioredis" · container "redis:7-alpine" · REDIS_URL
[high] s3        connector  · dependency "@aws-sdk/client-s3" · container "minio/minio" · S3_BUCKET
[high] kafka     no conn    · dependency "kafkajs" · container "redpanda" · KAFKA_BROKERS
```

### The nine connectors

| Connector | Driver (optional peer) | Reads | Produces |
|---|---|---|---|
| `postgresSource` | `postgres` | tables, columns, keys, indexes, enums, `COMMENT ON` | one doc per table + overview |
| `mysqlSource` | `mysql2` | same, via `information_schema` | one doc per table + overview |
| `mongodbSource` | `mongodb` | **samples** documents, infers fields | one doc per collection + overview |
| `dynamodbSource` | `@aws-sdk/client-dynamodb` | key schema, GSIs, **samples** items | one doc per table + overview |
| `elasticsearchSource` | `@elastic/elasticsearch` | declared index mappings | one doc per index + overview |
| `s3Source` | `@aws-sdk/client-s3` | buckets, prefix profile, sizes, types | one doc per bucket + overview |
| `redisSource` | `ioredis` | SCANs keys → key *grammar* | one keyspace doc |
| `openapiSource` | — | the spec, resolving local `$ref`s | one doc per operation + overview |
| `graphqlSource` | — | introspection | one doc per type + root ops |

**Drivers are optional peer dependencies.** Nine hard dependencies would put two
SQL drivers, a Mongo client and the AWS SDK into every install. Each is loaded by
dynamic `import()` when its connector runs, and a missing one is a configuration
error with the install command in it:

```
CONFIG_INVALID  No compatible driver found (tried postgres).
             →  Install one of: `postgres`.
```

**Document the shape, never the contents.** Schema connectors read no row data at
all. Sampling connectors (MongoDB, DynamoDB) must look at records to infer a
shape, so they record field names, types and presence rates — never values,
except enum-like sets small enough to *be* schema (`status is one of
pending|paid|refunded`). Every connection URL is redacted before it reaches a
document or a log: `postgres://po***:***@127.0.0.1:55432/orders`.

**Why one document per table / per operation / per index.** A single "here is the
whole schema" document is one embedding for eighty tables, so a query about
`refunds` scores no better than one about `sessions`. Per-object granularity
gives each object its own point in vector space, and its own citation.

The payoff, live against a real Postgres:

> **Q:** In the orders database, how do I find orders that can still be refunded?
>
> **A:** Query the `public.refundable_orders` view, which contains `id`,
> `customer_id`, `total_cents` [S1]. The `orders` table stores status in a
> `status` column of type `order_status`, whose values are `pending`, `paid`,
> `fulfilled`, `refunded`, `cancelled` [S2][S3]. Refunds are accepted within 45
> days of `placed_at`, and `refunded_at` is set when a refund completes [S2].

That 45-day rule came from a **column comment**. Nothing in the repository states
it. This is why the database is worth ingesting and not just the code.

---

## 3. Document persistence

Stage 1 stored only chunks, which is all retrieval needs. A UI that lists, edits
and deletes needs *documents*, and chunks are lossy — overlap duplicates text, so
a document cannot be faithfully reconstructed from them. So documents get their
own table in the same LanceDB directory, and the corpus service keeps the two
consistent under three invariants:

1. **Delete before upsert.** Chunk ids embed the document's content hash, so
   editing a document produces a *different* id set. Merge-insert alone would add
   the new chunks and leave the old ones retrievable forever.
2. **One dimension per table.** The vector width comes from the manifest when an
   index exists, and is only probed from the model when bootstrapping.
3. **The manifest follows the data.** Counts are recomputed after every mutation,
   so `chunkCount` is never a stale claim.

An `origin` column (`manual | file | github | service | api`) keeps the UI honest
about provenance — all four behave identically for retrieval and very differently
when you re-run a sync.

Editing only the title or tags skips re-embedding, which on a local CPU model is
the difference between an instant metadata edit and a multi-second round trip. The
save response says which happened, because a user who does not know that will
assume the tool is randomly slow.

---

## 4. The Studio

A Hono app — a plain `fetch` handler — that mounts under an existing app. The
static handler uses `Bun.file` and `import.meta.dir`, so the runtime is Bun:

```ts
import { createStudioRouter } from 'localmind/studio';

Bun.serve({ port: 3000, fetch: createStudioRouter().fetch });

// or under an existing app, sharing one set of LanceDB handles
app.route('/admin/mind', createStudioRouter({ mind }));
```

`hono/bun` is still avoided and the static handler hand-rolled, because that is
what lets the path-traversal guard and the cache-control policy live in this file
where they can be read. Traversal is guarded by resolving the path and then
checking containment, not by looking for `..`.

### Design language

The visual direction is Minimalism / Swiss — the family that suits dashboards and
professional tools. Concretely:

- **A four-step surface ramp** (page, panel, well, hover) where each step has a
  job. Borders are deliberately visible: the most common dark-UI failure is a
  border so close to its surface that panels dissolve.
- **Green as the single accent**, not blue. In a developer tool green reads as
  "run / verified / passing", which is what this UI signals most often. Blue is
  reserved for neutral-informational so green never becomes decoration.
- **JetBrains Mono for machine output, IBM Plex Sans for prose.** Scores, ids,
  paths, model names and counts are mono; anything a human wrote is sans. That
  split makes a data-dense screen scannable without a legend. Both fonts are
  **bundled**, not fetched from a CDN — a tool that claims to be local-first
  should not blank its type waiting on a font server.
- **Tabular figures** on every number that sits in a column, so a relevance score
  does not jitter as values change.
- **Measure-capped prose.** The answer column is limited to ~72ch; full-width
  prose on a 1600px display is the easiest readability mistake in an app that is
  otherwise panels and tables.
- **Citation chips.** `[S1]` markers in the answer are rendered as inline chips,
  so grounding is visible at a glance rather than something you read for.
- **Skeletons, not spinners**, wherever loaded content will occupy layout — a
  spinner replaced by a list causes a jump.
- **Accessibility that is actually wired**: `role="tablist"`/`tab` with
  `aria-selected`, `role="radiogroup"` for the mode selector, `aria-live` on the
  transcript, `aria-busy` on streaming regions, real `<label for>` bindings with
  `aria-describedby` hints, a focus trap that restores focus on close, visible
  2px focus rings that are never removed, and `prefers-reduced-motion` honoured.
  State is never carried by colour alone.

### Views

- **Chat** — the three answering modes side by side, so you can feel the
  difference on one question. Three columns rather than chat bubbles, because the
  interesting part of a RAG answer is *why* it says what it says: the trace and
  sources are peers of the answer, not hidden behind a disclosure triangle.
  Answers render through `streamdown` in `mode="streaming"`, which handles
  unterminated code fences and half-written tables mid-stream, and renders the
  Mermaid diagrams the repo analyzer produces.
- **Corpus** — list, create, edit, delete, re-index. Grouped by source run, with
  per-run deletion. The list fetches summaries only; the editor fetches one body.
- **Sources** — analyse a repo (a **dry run** that writes nothing), review the
  documents that *would* be created and the services detected with their
  evidence, then ingest. Each detected service with a connector gets a form built
  from the backend's own descriptor table, so the UI never hard-codes what
  Postgres needs.
- **Search** — raw retrieval with scores, distances and chunk ids. The debugging
  view: if the right passage is not here, the problem is chunking or embedding,
  not prompting.
- **Settings** — resolved configuration, read-only. Configuration is
  environment-driven, and a UI that mutates it would create a second source of
  truth that disagrees with the `.env` a deployment boots from.

### The wire protocol

`localmind/protocol` declares every request and SSE event once, and both the
server and the UI import it. A renamed field is a type error on both sides
instead of a silently mis-rendered panel.

SSE rather than WebSockets: every long operation here is one-directional
server→client progress, and SSE gives that over plain HTTP with no protocol
upgrade — which matters when the router is mounted behind someone else's proxy.
The client reads it with `fetch` + a small parser rather than `EventSource`,
because `EventSource` cannot issue a POST and every streaming endpoint needs a
body.

### API surface

| Route | Purpose |
|---|---|
| `GET /api/health` | Models, store, retrieval config, corpus stats, connector descriptors |
| `GET /api/corpus` | Document summaries, filterable by search and origin |
| `GET·POST·PUT·DELETE /api/corpus/:id` | Document CRUD |
| `POST /api/corpus/reindex` | SSE: re-chunk and re-embed everything |
| `DELETE /api/sources/:ref` | Remove every document from one source run |
| `POST /api/search` | Retrieval only |
| `GET /api/connectors` | Connector descriptors (drives the connection forms) |
| `POST /api/sources/analyze` | SSE: repository dry run → preview + detected services |
| `POST /api/sources/ingest` | SSE: run any source and commit it |
| `POST /api/chat` | SSE: `ask` streams deltas; `agent` and `research` stream phases |

---

## 5. What is verified, and what is not

Verified live in development:

- Corpus CRUD, including delete-before-upsert (`1 written / 1 removed`), the
  metadata-only skip, and an edit being retrievable at 0.736 immediately after
  saving — with the new value, not the old one.
- The GitHub analyzer on a local checkout and on a remote clone (`honojs/hono`,
  431 files), with and without synthesis.
- Service detection: four services, each corroborated by three signals.
- The **Postgres** connector against a real container: 4 relations → 5 documents,
  comments and enums intact, credentials redacted.
- The **OpenAPI** connector against a public spec: 19 operations → 20 documents.
- The missing-driver error path.
- All three chat modes through the SSE API and through the browser UI.
- 43 hermetic tests, plus a NodeNext consumer typecheck against the built
  declarations.

**Not verified against live infrastructure:** MySQL, MongoDB, Redis, S3,
DynamoDB, Elasticsearch and GraphQL. They are implemented, typechecked, and share
the driver-loading, redaction and error paths that the Postgres and OpenAPI
connectors exercised — but no instance of any of them was available to point at.
Treat them as untested code paths until you run one.
