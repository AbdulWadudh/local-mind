import { style } from '../core/ansi';
import { loadConfig } from '../core/config';
import type { LocalMindConfig } from '../core/config';
import { describeUnknownError, reportFatal } from '../core/errors';
import { createModelRegistry, probeEmbeddingDimensions } from '../core/providers';
import { readManifest } from '../store/manifest';
import { loadCorpus } from '../ingest/loader';

import { formatDuration, heading, kv } from './shared';

/**
 * `bun run doctor` - preflight diagnostics.
 *
 * Every check here corresponds to a real failure I would otherwise have to
 * explain in a stack trace: a model that was never pulled, an index built with a
 * different embedding model, an Ollama daemon that is not running. Diagnosing
 * those in one command beats diagnosing them from a retrieval that returned
 * plausible nonsense.
 *
 * Exits 0 if everything required to run Stage 1 is present, 1 otherwise.
 * Warnings do not fail the run.
 */

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly remedy?: string;
}

const MARK: Readonly<Record<Status, string>> = {
  ok: style.green('ok  '),
  warn: style.yellow('warn'),
  fail: style.red('fail'),
};

async function checkOllama(config: LocalMindConfig): Promise<Check[]> {
  const usesOllama = config.chat.provider === 'ollama' || config.embedding.provider === 'ollama';
  if (!usesOllama) {
    return [{ name: 'ollama', status: 'ok', detail: 'not used by the current configuration' }];
  }

  const url = `${config.ollama.baseUrl.replace(/\/$/u, '')}/api/tags`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return [
        {
          name: 'ollama daemon',
          status: 'fail',
          detail: `${config.ollama.baseUrl} returned HTTP ${response.status}`,
          remedy: 'Start it with `ollama serve`, or point OLLAMA_BASE_URL at a running instance.',
        },
      ];
    }

    const body = (await response.json()) as { models?: { name?: string }[] };
    const installed = (body.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === 'string');

    const checks: Check[] = [
      {
        name: 'ollama daemon',
        status: 'ok',
        detail: `${config.ollama.baseUrl} (${installed.length} model(s) installed)`,
      },
    ];

    // Ollama reports tags as "name:tag"; a bare configured name means ":latest".
    const has = (wanted: string): boolean =>
      installed.some((name) => name === wanted || name.split(':')[0] === wanted.split(':')[0]);

    if (config.embedding.provider === 'ollama') {
      checks.push(
        has(config.embedding.model)
          ? { name: 'embedding model', status: 'ok', detail: config.embedding.model }
          : {
              name: 'embedding model',
              status: 'fail',
              detail: `${config.embedding.model} is not installed`,
              remedy: `ollama pull ${config.embedding.model}`,
            },
      );
    }

    if (config.chat.provider === 'ollama') {
      checks.push(
        has(config.chat.model)
          ? { name: 'chat model', status: 'ok', detail: config.chat.model }
          : {
              name: 'chat model',
              status: 'warn',
              detail: `${config.chat.model} is not installed (Stages 2-4 will fail)`,
              remedy: `ollama pull ${config.chat.model}`,
            },
      );
    }

    return checks;
  } catch (error) {
    return [
      {
        name: 'ollama daemon',
        status: 'fail',
        detail: `cannot reach ${config.ollama.baseUrl}: ${describeUnknownError(error)}`,
        remedy: 'Run `ollama serve` in another terminal, or set LOCALMIND_CHAT_PROVIDER=openrouter and LOCALMIND_EMBEDDING_PROVIDER=openrouter.',
      },
    ];
  }
}

async function checkOpenRouter(config: LocalMindConfig): Promise<Check[]> {
  const uses =
    config.chat.provider === 'openrouter' ||
    config.embedding.provider === 'openrouter' ||
    config.webSearch.mode === 'openrouter';

  if (!uses) return [];

  if (config.openrouter.apiKey === undefined) {
    return [
      {
        name: 'openrouter key',
        status: 'fail',
        detail: 'OPENROUTER_API_KEY is not set',
        remedy: 'Add OPENROUTER_API_KEY to .env, or switch the affected provider back to ollama.',
      },
    ];
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return [
        {
          name: 'openrouter catalogue',
          status: 'warn',
          detail: `model list unavailable (HTTP ${response.status}); cannot validate the configured slug`,
        },
      ];
    }

    const body = (await response.json()) as { data?: { id?: string; supported_parameters?: string[] }[] };
    const models = body.data ?? [];
    const entry = models.find((model) => model.id === config.chat.model);

    if (entry === undefined) {
      return [
        {
          name: 'openrouter model',
          status: 'fail',
          detail: `"${config.chat.model}" is not in the OpenRouter catalogue`,
          remedy: 'Pick a slug from https://openrouter.ai/models. "openrouter/free" is a good zero-cost default.',
        },
      ];
    }

    const params = new Set(entry.supported_parameters ?? []);
    const checks: Check[] = [
      { name: 'openrouter model', status: 'ok', detail: `${config.chat.model} is available` },
    ];

    // Stages 3 and 4 are not merely degraded without these; they cannot run.
    const missing = ['tools', 'structured_outputs'].filter((capability) => !params.has(capability));
    checks.push(
      missing.length === 0
        ? { name: 'model capabilities', status: 'ok', detail: 'tools + structured_outputs supported' }
        : {
            name: 'model capabilities',
            status: 'warn',
            detail: `${config.chat.model} does not advertise: ${missing.join(', ')} (Stages 3-4 need both)`,
            remedy: 'Choose a model that supports tool calling and structured outputs.',
          },
    );

    return checks;
  } catch (error) {
    return [
      {
        name: 'openrouter catalogue',
        status: 'warn',
        detail: `could not validate the model slug: ${describeUnknownError(error)}`,
      },
    ];
  }
}

async function checkCorpus(config: LocalMindConfig): Promise<Check> {
  try {
    const documents = await loadCorpus({ corpusDir: config.store.corpusDir });
    const chars = documents.reduce((sum, document) => sum + document.charCount, 0);
    return {
      name: 'corpus',
      status: 'ok',
      detail: `${documents.length} document(s), ${chars.toLocaleString()} chars in ${config.store.corpusDir}/`,
    };
  } catch (error) {
    return {
      name: 'corpus',
      status: 'fail',
      detail: describeUnknownError(error),
      remedy: `Add .md or .txt files to ${config.store.corpusDir}/`,
    };
  }
}

async function checkIndex(config: LocalMindConfig): Promise<Check> {
  const manifest = await readManifest(config.store.dbPath);
  if (manifest === undefined) {
    return {
      name: 'index',
      status: 'warn',
      detail: 'no index built yet',
      remedy: 'bun run ingest',
    };
  }

  const providerMatch = manifest.embeddingProvider === config.embedding.provider;
  const modelMatch = manifest.embeddingModel === config.embedding.model;

  if (providerMatch && modelMatch) {
    return {
      name: 'index',
      status: 'ok',
      detail: `${manifest.chunkCount} chunks, ${manifest.dimensions}d, ${manifest.embeddingModel}, updated ${manifest.updatedAt}`,
    };
  }

  return {
    name: 'index',
    status: 'fail',
    detail: `built with ${manifest.embeddingProvider}/${manifest.embeddingModel} but configured for ${config.embedding.provider}/${config.embedding.model}`,
    remedy: 'bun run ingest --rebuild  (querying across two vector spaces returns semantically random results)',
  };
}

async function checkEmbeddingCall(config: LocalMindConfig): Promise<Check> {
  const startedAt = Date.now();
  try {
    const registry = createModelRegistry(config);
    const dimensions = await probeEmbeddingDimensions(registry.embedding, {
      signal: AbortSignal.timeout(60_000),
    });
    return {
      name: 'embedding probe',
      status: 'ok',
      detail: `${dimensions} dimensions in ${formatDuration(Date.now() - startedAt)}`,
    };
  } catch (error) {
    return {
      name: 'embedding probe',
      status: 'fail',
      detail: describeUnknownError(error),
      remedy: 'Fix the provider issues above first; this check exercises a real embedding call.',
    };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  process.stderr.write(`${style.bold('LocalMind doctor')}\n`);

  heading('Configuration');
  kv('chat', `${config.chat.provider} / ${config.chat.model}`);
  kv('grader', `${config.chat.provider} / ${config.chat.graderModel}`);
  kv('embedding', `${config.embedding.provider} / ${config.embedding.model}`);
  kv('vector store', `${config.store.dbPath} # ${config.store.tableName}`);
  kv('corpus', config.store.corpusDir);
  kv('chunking', `${config.chunking.maxChars} chars / ${config.chunking.overlapChars} overlap`);
  kv('retrieval', `topK=${config.retrieval.topK} minScore=${config.retrieval.minScore} ctx=${config.retrieval.maxContextTokens}`);
  kv('web fallback', config.webSearch.mode);

  const checks: Check[] = [
    ...(await checkOllama(config)),
    ...(await checkOpenRouter(config)),
    await checkCorpus(config),
    await checkIndex(config),
  ];

  // Only spend a real embedding call if the transport looks healthy.
  if (!checks.some((check) => check.status === 'fail')) {
    checks.push(await checkEmbeddingCall(config));
  } else {
    checks.push({
      name: 'embedding probe',
      status: 'warn',
      detail: 'skipped because an earlier check failed',
    });
  }

  heading('Checks');
  for (const check of checks) {
    process.stderr.write(`  ${MARK[check.status]} ${style.bold(check.name.padEnd(18))} ${check.detail}\n`);
    if (check.remedy !== undefined) {
      process.stderr.write(`       ${style.yellow(`-> ${check.remedy}`)}\n`);
    }
  }

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;

  process.stderr.write(
    `\n${failures === 0 ? style.green('ready') : style.red(`${failures} blocking issue(s)`)}` +
      `${warnings > 0 ? style.yellow(`, ${warnings} warning(s)`) : ''}\n\n`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch(reportFatal);
