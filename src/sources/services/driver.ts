import { LocalMindError, describeUnknownError } from '../../core/errors';
import { createLogger } from '../../core/logger';

/**
 * Optional driver loading.
 *
 * Nine connectors ship here. Making their drivers hard dependencies would put
 * the AWS SDK, a Mongo driver, an Elasticsearch client and two SQL drivers into
 * every install of LocalMind, most of which will use none of them. So each
 * driver is loaded by dynamic `import()` at the moment it is needed, and the
 * package declares them as *optional* peers.
 *
 * The specifier is deliberately held in a variable rather than written as a
 * literal: a literal `import('mysql2')` makes TypeScript demand the types at
 * compile time, which would defeat the entire point. The cost is that the
 * boundary is untyped, so each connector declares a minimal local interface for
 * exactly the surface it uses and casts once, right here.
 */

const log = createLogger('sources:driver');

export interface DriverSpec {
  /** npm specifier, e.g. `@aws-sdk/client-s3`. */
  readonly specifier: string;
  /** Human name used in the error message. */
  readonly label: string;
}

/**
 * Load an optional driver, or fail with an install command.
 *
 * The failure here is a *configuration* error, not a runtime one: the user asked
 * to connect to Postgres and the machine has no Postgres driver. Saying exactly
 * which package to install is the whole job of the error.
 */
export async function loadDriver<T>(spec: DriverSpec): Promise<T> {
  try {
    // Variable specifier: intentional, see the module comment.
    const specifier = spec.specifier;
    const loaded = (await import(specifier)) as unknown;
    log.debug('driver loaded', { specifier });
    return loaded as T;
  } catch (error) {
    const message = describeUnknownError(error);

    // A module that exists but throws on import is a different problem from one
    // that is not installed, and conflating them sends people down the wrong path.
    const notInstalled = /Cannot find module|Failed to resolve|ERR_MODULE_NOT_FOUND|Cannot find package/iu.test(message);

    throw new LocalMindError(
      'CONFIG_INVALID',
      notInstalled
        ? `The ${spec.label} driver is not installed.`
        : `The ${spec.label} driver failed to load: ${message}`,
      {
        remedy: notInstalled
          ? `Install it in your project: \`bun add ${spec.specifier}\` (or \`npm i ${spec.specifier}\`). LocalMind declares database drivers as optional peers so you only install the ones you use.`
          : 'The package is present but could not be imported. Check its version is compatible with your runtime.',
        details: { specifier: spec.specifier },
        cause: error,
      },
    );
  }
}

/** Try several specifiers in order, returning the first that loads. */
export async function loadAnyDriver<T>(specs: readonly DriverSpec[]): Promise<{ driver: T; spec: DriverSpec }> {
  const attempted: string[] = [];

  for (const spec of specs) {
    try {
      const specifier = spec.specifier;
      const loaded = (await import(specifier)) as unknown;
      return { driver: loaded as T, spec };
    } catch {
      attempted.push(spec.specifier);
    }
  }

  throw new LocalMindError('CONFIG_INVALID', `No compatible driver found (tried ${attempted.join(', ')}).`, {
    remedy: `Install one of: ${specs.map((spec) => `\`${spec.specifier}\``).join(', ')}.`,
    details: { attempted },
  });
}

/**
 * Redact anything credential-shaped before it reaches a document or a log.
 *
 * Connectors produce documents that get embedded, stored, and later shown to a
 * model and a user. A connection string that leaks into that pipeline is
 * effectively published. This runs over every URL a connector records.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password !== '') url.password = '***';
    if (url.username !== '') url.username = url.username.slice(0, 2) + '***';
    return url.toString();
  } catch {
    // Not a URL (a DSN, a key-value string). Strip anything that looks assigned
    // to a secret-ish key.
    return raw.replace(
      /\b(password|passwd|pwd|secret|token|key|apikey|api_key|access_key|sas)\s*[=:]\s*[^\s;,&]+/giu,
      '$1=***',
    );
  }
}

/** Truncate a long list for a document, noting what was omitted. */
export function capList<T>(items: readonly T[], limit: number): { shown: readonly T[]; omitted: number } {
  if (items.length <= limit) return { shown: items, omitted: 0 };
  return { shown: items.slice(0, limit), omitted: items.length - limit };
}

/** Render a markdown table, skipping it entirely when there are no rows. */
export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_none_';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/gu, '\\|')).join(' | ')} |`),
  ].join('\n');
}

/** Wrap a connector body so driver/network errors become typed LocalMind errors. */
export async function withConnector<T>(
  label: string,
  operation: () => Promise<T>,
  remedy: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (LocalMindError.is(error)) throw error;
    throw new LocalMindError('PROVIDER_UNAVAILABLE', `${label} introspection failed: ${describeUnknownError(error)}`, {
      remedy,
      cause: error,
    });
  }
}
