import { parse as parseYaml } from 'yaml';

import { LocalMindError, describeUnknownError } from '../../core/errors';
import { readText } from '../../core/fs';
import { createLogger } from '../../core/logger';
import type { CorpusDocumentInput } from '../../corpus/corpus-service';
import type { DataSource, SourceCollectResult, SourceContext } from '../types';

import { capList, markdownTable, redactUrl } from './driver';

/**
 * API contract sources: OpenAPI and GraphQL.
 *
 * These two need no driver — both are just schemas, reachable over HTTP or read
 * from a file — which makes them the cheapest high-value connectors here. An API
 * contract is the most precisely written documentation a system has, and it is
 * usually the thing developers actually want to ask questions about.
 *
 * ONE DOCUMENT PER OPERATION / PER TYPE
 * Same reasoning as one-document-per-table in the SQL connector. A single
 * document holding 200 endpoints is one vector for 200 topics, so "how do I
 * cancel a subscription" would rank no better than any other query. Splitting by
 * operation gives each endpoint its own point in the vector space, and its own
 * citation.
 */

const log = createLogger('sources:api');

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 70);
}

async function loadSpecText(source: { url?: string; path?: string; headers?: Record<string, string> }): Promise<string> {
  if (source.path !== undefined) {
    try {
      return await readText(source.path);
    } catch (error) {
      throw new LocalMindError('CORPUS_UNREADABLE', `Could not read "${source.path}".`, {
        remedy: 'Check the path to the specification file.',
        cause: error,
      });
    }
  }

  if (source.url === undefined) {
    throw new LocalMindError('CONFIG_INVALID', 'Provide either `url` or `path`.', {
      remedy: 'openapiSource({ url: "https://api.example.com/openapi.json" }) or ({ path: "./openapi.yaml" })',
    });
  }

  try {
    const response = await fetch(source.url, {
      headers: source.headers ?? {},
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    throw new LocalMindError('PROVIDER_UNAVAILABLE', `Could not fetch ${redactUrl(source.url)}: ${describeUnknownError(error)}`, {
      remedy: 'Check the URL is reachable and any auth headers are correct.',
      cause: error,
    });
  }
}

function parseSpec(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('{')) return JSON.parse(trimmed) as Record<string, unknown>;
    return (parseYaml(trimmed) ?? {}) as Record<string, unknown>;
  } catch (error) {
    throw new LocalMindError('CORPUS_UNREADABLE', `The specification is neither valid JSON nor valid YAML: ${describeUnknownError(error)}`, {
      remedy: 'Validate the document, then retry.',
      cause: error,
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * OpenAPI
 * ──────────────────────────────────────────────────────────────────────────── */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface OperationInfo {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly parameters: readonly { name: string; location: string; required: boolean; type: string; description: string }[];
  readonly requestBody: string;
  readonly responses: readonly { status: string; description: string }[];
  readonly deprecated: boolean;
}

/** Resolve a local `$ref`. Remote refs are out of scope and returned as-is. */
function resolveRef(spec: Record<string, unknown>, node: unknown, depth = 0): unknown {
  if (depth > 8 || node === null || typeof node !== 'object') return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;

  let current: unknown = spec;
  for (const segment of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return node;
    current = (current as Record<string, unknown>)[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  return resolveRef(spec, current, depth + 1);
}

function describeSchema(spec: Record<string, unknown>, node: unknown, depth = 0): string {
  const resolved = resolveRef(spec, node) as Record<string, unknown> | null;
  if (resolved === null || typeof resolved !== 'object') return 'unknown';
  if (depth > 3) return '…';

  const type = resolved['type'];
  const format = resolved['format'];
  const enumValues = resolved['enum'];

  if (Array.isArray(enumValues)) {
    return `enum(${enumValues.slice(0, 8).map((value) => String(value)).join(' | ')})`;
  }
  if (type === 'array') {
    return `${describeSchema(spec, resolved['items'], depth + 1)}[]`;
  }
  if (type === 'object' || resolved['properties'] !== undefined) {
    const properties = (resolved['properties'] ?? {}) as Record<string, unknown>;
    const keys = Object.keys(properties);
    const { shown, omitted } = capList(keys, 8);
    const inner = shown.map((key) => `${key}: ${describeSchema(spec, properties[key], depth + 1)}`).join(', ');
    return `{ ${inner}${omitted > 0 ? `, …+${omitted}` : ''} }`;
  }
  if (typeof type === 'string') return typeof format === 'string' ? `${type}<${format}>` : type;

  for (const composite of ['oneOf', 'anyOf', 'allOf']) {
    const branch = resolved[composite];
    if (Array.isArray(branch)) {
      return `${composite}(${branch.slice(0, 4).map((entry) => describeSchema(spec, entry, depth + 1)).join(' | ')})`;
    }
  }
  return 'unknown';
}

function extractOperations(spec: Record<string, unknown>): OperationInfo[] {
  const paths = (spec['paths'] ?? {}) as Record<string, unknown>;
  const operations: OperationInfo[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolveRef(spec, rawItem) as Record<string, unknown> | null;
    if (item === null) continue;

    // Path-level parameters apply to every operation under the path.
    const sharedParameters = (item['parameters'] ?? []) as unknown[];

    for (const method of HTTP_METHODS) {
      const rawOperation = item[method];
      if (rawOperation === null || typeof rawOperation !== 'object') continue;
      const operation = rawOperation as Record<string, unknown>;

      const parameterNodes = [...sharedParameters, ...((operation['parameters'] ?? []) as unknown[])];
      const parameters = parameterNodes.map((node) => {
        const parameter = (resolveRef(spec, node) ?? {}) as Record<string, unknown>;
        return {
          name: String(parameter['name'] ?? ''),
          location: String(parameter['in'] ?? ''),
          required: parameter['required'] === true,
          type: describeSchema(spec, parameter['schema']),
          description: String(parameter['description'] ?? ''),
        };
      });

      const body = resolveRef(spec, operation['requestBody']) as Record<string, unknown> | null;
      const bodyContent = (body?.['content'] ?? {}) as Record<string, unknown>;
      const bodyMediaType = Object.keys(bodyContent)[0];
      const requestBody =
        bodyMediaType === undefined
          ? ''
          : `${bodyMediaType}: ${describeSchema(spec, (bodyContent[bodyMediaType] as Record<string, unknown>)?.['schema'])}`;

      const responseEntries = Object.entries((operation['responses'] ?? {}) as Record<string, unknown>);
      const responses = responseEntries.map(([status, rawResponse]) => {
        const response = (resolveRef(spec, rawResponse) ?? {}) as Record<string, unknown>;
        const content = (response['content'] ?? {}) as Record<string, unknown>;
        const mediaType = Object.keys(content)[0];
        const shape =
          mediaType === undefined
            ? ''
            : ` → ${describeSchema(spec, (content[mediaType] as Record<string, unknown>)?.['schema'])}`;
        return { status, description: `${String(response['description'] ?? '')}${shape}` };
      });

      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: String(operation['operationId'] ?? `${method}-${path}`),
        summary: String(operation['summary'] ?? ''),
        description: String(operation['description'] ?? ''),
        tags: ((operation['tags'] ?? []) as unknown[]).map((tag) => String(tag)),
        parameters,
        requestBody,
        responses,
        deprecated: operation['deprecated'] === true,
      });
    }
  }

  return operations;
}

export interface OpenApiSourceOptions {
  readonly url?: string;
  readonly path?: string;
  readonly headers?: Record<string, string>;
  readonly label?: string;
}

export function openapiSource(options: OpenApiSourceOptions): DataSource {
  const identifier = options.url ?? options.path ?? 'openapi';
  const label = options.label ?? identifier.split('/').pop() ?? 'openapi';
  const ref = `openapi:${label}`;

  return {
    kind: 'openapi',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'fetch', detail: redactUrl(identifier) });

      const spec = parseSpec(
        await loadSpecText({
          ...(options.url !== undefined ? { url: options.url } : {}),
          ...(options.path !== undefined ? { path: options.path } : {}),
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
        }),
      );

      const info = (spec['info'] ?? {}) as Record<string, unknown>;
      const title = String(info['title'] ?? label);
      const version = String(info['version'] ?? 'unversioned');
      const operations = extractOperations(spec);

      context.onProgress?.({ stage: 'document', detail: `${operations.length} operations` });

      const base = { origin: 'service' as const, sourceRef: ref, tags: ['openapi', 'api', label] };
      const documents: CorpusDocumentInput[] = [];

      // ── Overview ─────────────────────────────────────────────────────────
      const servers = ((spec['servers'] ?? []) as { url?: string; description?: string }[]).map(
        (server) => `- \`${server.url ?? ''}\`${server.description !== undefined ? ` — ${server.description}` : ''}`,
      );

      documents.push({
        ...base,
        id: `svc-${slug(ref)}-overview`,
        title: `${title} — API overview (v${version})`,
        sourcePath: identifier,
        text: [
          `# ${title} — API overview`,
          '',
          `Version \`${version}\`. ${operations.length} operations across ${new Set(operations.map((operation) => operation.path)).size} paths.`,
          typeof info['description'] === 'string' ? `\n${info['description']}\n` : '',
          servers.length > 0 ? `## Servers\n\n${servers.join('\n')}\n` : '',
          '## Operations',
          '',
          markdownTable(
            ['Method', 'Path', 'Operation', 'Summary'],
            operations.map((operation) => [
              operation.method,
              `\`${operation.path}\``,
              `\`${operation.operationId}\``,
              (operation.summary || operation.description).slice(0, 70) || '—',
            ]),
          ),
        ]
          .filter((line) => line !== '')
          .join('\n'),
      });

      // ── One document per operation ───────────────────────────────────────
      for (const operation of operations) {
        documents.push({
          ...base,
          id: `svc-${slug(ref)}-op-${slug(`${operation.method}-${operation.path}`)}`,
          title: `${operation.method} ${operation.path}`,
          sourcePath: `${identifier}#${operation.operationId}`,
          tags: [...base.tags, 'endpoint', ...operation.tags],
          text: [
            `# ${operation.method} ${operation.path}`,
            '',
            operation.deprecated ? '> **Deprecated.**\n' : '',
            operation.summary.length > 0 ? `${operation.summary}\n` : '',
            operation.description.length > 0 ? `${operation.description}\n` : '',
            `Operation id: \`${operation.operationId}\`${operation.tags.length > 0 ? ` · tags: ${operation.tags.join(', ')}` : ''}`,
            '',
            operation.parameters.length > 0
              ? [
                  '## Parameters',
                  '',
                  markdownTable(
                    ['Name', 'In', 'Required', 'Type', 'Description'],
                    operation.parameters.map((parameter) => [
                      `\`${parameter.name}\``,
                      parameter.location,
                      parameter.required ? 'yes' : 'no',
                      `\`${parameter.type}\``,
                      parameter.description.slice(0, 80) || '—',
                    ]),
                  ),
                  '',
                ].join('\n')
              : '',
            operation.requestBody.length > 0 ? `## Request body\n\n\`${operation.requestBody}\`\n` : '',
            operation.responses.length > 0
              ? [
                  '## Responses',
                  '',
                  markdownTable(
                    ['Status', 'Description'],
                    operation.responses.map((response) => [`\`${response.status}\``, response.description || '—']),
                  ),
                ].join('\n')
              : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        });
      }

      log.info('openapi collected', { label, operations: operations.length });

      return {
        documents,
        warnings: operations.length === 0 ? ['No operations were found; is this an OpenAPI document?'] : [],
        detectedServices: [],
        stats: { api: title, version, operations: operations.length, documents: documents.length },
      };
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * GraphQL
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Minimal introspection query.
 *
 * Deliberately hand-written rather than pulled from the `graphql` package: it
 * keeps this connector dependency-free, and the full introspection query returns
 * far more than is useful for documentation.
 */
const INTROSPECTION_QUERY = `
query LocalMindIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        args { name description type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name description }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name } } }
}`;

interface GraphqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GraphqlTypeRef | null;
}

interface GraphqlField {
  name: string;
  description: string | null;
  isDeprecated?: boolean;
  args?: { name: string; description: string | null; type: GraphqlTypeRef }[];
  type: GraphqlTypeRef;
}

interface GraphqlType {
  kind: string;
  name: string | null;
  description: string | null;
  fields: GraphqlField[] | null;
  inputFields: { name: string; description: string | null; type: GraphqlTypeRef }[] | null;
  enumValues: { name: string; description: string | null }[] | null;
}

/** Render a type ref the way a GraphQL developer writes it: `[User!]!`. */
function renderTypeRef(ref: GraphqlTypeRef | null | undefined): string {
  if (ref === null || ref === undefined) return 'Unknown';
  if (ref.kind === 'NON_NULL') return `${renderTypeRef(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${renderTypeRef(ref.ofType)}]`;
  return ref.name ?? 'Unknown';
}

export interface GraphqlSourceOptions {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly label?: string;
}

export function graphqlSource(options: GraphqlSourceOptions): DataSource {
  const label = options.label ?? new URL(options.url).host;
  const ref = `graphql:${label}`;

  return {
    kind: 'graphql',
    ref,
    label,

    async collect(context: SourceContext): Promise<SourceCollectResult> {
      context.onProgress?.({ stage: 'introspect', detail: redactUrl(options.url) });

      let payload: { data?: { __schema?: { types?: GraphqlType[]; queryType?: { name: string }; mutationType?: { name: string } | null } }; errors?: unknown };
      try {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
          body: JSON.stringify({ query: INTROSPECTION_QUERY }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        payload = (await response.json()) as typeof payload;
      } catch (error) {
        throw new LocalMindError('PROVIDER_UNAVAILABLE', `GraphQL introspection failed: ${describeUnknownError(error)}`, {
          remedy: 'Check the endpoint URL and auth headers. Many production servers disable introspection — point this at a staging endpoint or export the SDL instead.',
          cause: error,
        });
      }

      if (payload.errors !== undefined || payload.data?.__schema === undefined) {
        throw new LocalMindError('PROVIDER_UNAVAILABLE', 'The endpoint rejected the introspection query.', {
          remedy: 'Introspection is commonly disabled in production. Use a staging endpoint, or supply an auth header that permits introspection.',
          details: { errors: JSON.stringify(payload.errors ?? {}).slice(0, 300) },
        });
      }

      const schema = payload.data.__schema;
      const allTypes = (schema.types ?? []).filter(
        (type) => type.name !== null && !type.name.startsWith('__'),
      );

      const base = { origin: 'service' as const, sourceRef: ref, tags: ['graphql', 'api', label] };
      const documents: CorpusDocumentInput[] = [];

      // ── Root operations get their own document ───────────────────────────
      for (const rootName of [schema.queryType?.name, schema.mutationType?.name].filter(
        (name): name is string => typeof name === 'string',
      )) {
        const rootType = allTypes.find((type) => type.name === rootName);
        if (rootType?.fields == null) continue;

        documents.push({
          ...base,
          id: `svc-${slug(ref)}-root-${slug(rootName)}`,
          title: `${label} — ${rootName} operations`,
          sourcePath: `${options.url}#${rootName}`,
          tags: [...base.tags, 'operations'],
          text: [
            `# ${rootName} operations`,
            '',
            `The \`${rootName}\` root type of the ${label} GraphQL API exposes ${rootType.fields.length} operations.`,
            '',
            markdownTable(
              ['Operation', 'Arguments', 'Returns', 'Description'],
              rootType.fields.map((field) => [
                `\`${field.name}\``,
                (field.args ?? []).map((argument) => `${argument.name}: ${renderTypeRef(argument.type)}`).join(', ') || '—',
                `\`${renderTypeRef(field.type)}\``,
                (field.description ?? '').slice(0, 80) || '—',
              ]),
            ),
          ].join('\n'),
        });
      }

      // ── One document per object / input / enum type ──────────────────────
      const documented = allTypes.filter(
        (type) =>
          ['OBJECT', 'INPUT_OBJECT', 'ENUM', 'INTERFACE'].includes(type.kind) &&
          type.name !== schema.queryType?.name &&
          type.name !== schema.mutationType?.name,
      );

      for (const type of documented) {
        const name = type.name ?? 'Unknown';
        const fields = type.fields ?? type.inputFields ?? [];

        documents.push({
          ...base,
          id: `svc-${slug(ref)}-type-${slug(name)}`,
          title: `${label} — ${type.kind.toLowerCase()} ${name}`,
          sourcePath: `${options.url}#${name}`,
          tags: [...base.tags, 'type'],
          text: [
            `# ${name}`,
            '',
            `A GraphQL \`${type.kind.toLowerCase()}\` in the ${label} schema.`,
            type.description !== null ? `\n${type.description}\n` : '',
            type.enumValues !== null && type.enumValues.length > 0
              ? [
                  '## Values',
                  '',
                  markdownTable(
                    ['Value', 'Description'],
                    type.enumValues.map((value) => [`\`${value.name}\``, (value.description ?? '').slice(0, 80) || '—']),
                  ),
                ].join('\n')
              : '',
            fields.length > 0
              ? [
                  '## Fields',
                  '',
                  markdownTable(
                    ['Field', 'Type', 'Description'],
                    fields.map((field) => [
                      `\`${field.name}\``,
                      `\`${renderTypeRef(field.type)}\``,
                      (field.description ?? '').slice(0, 90) || '—',
                    ]),
                  ),
                ].join('\n')
              : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        });
      }

      log.info('graphql collected', { label, types: documented.length });

      return {
        documents,
        warnings: [],
        detectedServices: [],
        stats: { endpoint: label, types: documented.length, documents: documents.length },
      };
    },
  };
}
