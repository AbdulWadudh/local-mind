/**
 * STAGE 4 - VERIFY
 *
 * Fixture corpus for the offline web-search provider.
 *
 * These entries are deliberately about topics the local `corpus/` does NOT
 * cover. That is the point: it lets `bun run verify --offline` prove the
 * *self-correction path* actually fires — grade says "irrelevant", the rewrite
 * does not help, the graph falls back to web search, and the answer cites a web
 * source — all without a network call or a nondeterministic backend.
 *
 * Snippets are paraphrased summaries written for this repo, not quotations.
 */

export interface WebFixture {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Extra retrieval terms, since a short snippet has a thin token surface. */
  readonly keywords: readonly string[];
}

export const OFFLINE_WEB_CORPUS: readonly WebFixture[] = [
  {
    title: 'Kubernetes Horizontal Pod Autoscaler behaviour',
    url: 'https://example.invalid/docs/k8s-hpa-scaling',
    snippet:
      'The Horizontal Pod Autoscaler samples metrics every 15 seconds by default and compares the observed value against the target. Scale-up is immediate once the threshold is crossed, while scale-down waits for a stabilisation window of 300 seconds to avoid thrashing. The stabilisation window is configurable per-direction under the behaviour field.',
    keywords: ['kubernetes', 'autoscaler', 'hpa', 'scaling', 'pods', 'stabilisation', 'replicas', 'cluster'],
  },
  {
    title: 'PostgreSQL VACUUM and transaction ID wraparound',
    url: 'https://example.invalid/docs/postgres-vacuum-wraparound',
    snippet:
      'Autovacuum triggers an aggressive freeze once a table age exceeds autovacuum_freeze_max_age, which defaults to 200 million transactions. If the transaction ID counter approaches wraparound the database refuses new write transactions to protect data integrity, so monitoring datfrozenxid age is essential on high-write clusters.',
    keywords: ['postgres', 'postgresql', 'vacuum', 'autovacuum', 'wraparound', 'transaction', 'freeze', 'database'],
  },
  {
    title: 'HTTP 103 Early Hints',
    url: 'https://example.invalid/docs/http-early-hints',
    snippet:
      'HTTP status 103 Early Hints lets a server send preliminary Link headers before the final response, so a client can begin preloading critical stylesheets and scripts while the origin is still generating the page. It is an informational response, so a client may receive several before the definitive status line.',
    keywords: ['http', 'early', 'hints', '103', 'preload', 'headers', 'browser', 'latency'],
  },
  {
    title: 'Rust ownership, borrowing and lifetimes',
    url: 'https://example.invalid/docs/rust-ownership-model',
    snippet:
      'Every value in Rust has exactly one owner, and the value is dropped when the owner goes out of scope. References borrow a value without taking ownership: any number of immutable borrows may coexist, but a mutable borrow is exclusive. Lifetimes are the compiler annotations that prove no reference outlives the data it points at.',
    keywords: ['rust', 'ownership', 'borrowing', 'lifetimes', 'memory', 'borrow', 'checker', 'references'],
  },
  {
    title: 'TLS 1.3 handshake round trips',
    url: 'https://example.invalid/docs/tls13-handshake',
    snippet:
      'TLS 1.3 completes a full handshake in one round trip by having the client send its key share in the initial ClientHello. Session resumption with a pre-shared key can send application data in the first flight, giving zero round trips, at the cost of losing replay protection for that early data.',
    keywords: ['tls', 'handshake', 'encryption', 'round', 'trip', 'resumption', 'zero', 'security', 'certificate'],
  },
];
