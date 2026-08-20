import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  ArrowUp,
  BadgeCheck,
  Bot,
  ChevronRight,
  CircleSlash,
  Code,
  FileText,
  Globe,
  Layers,
  MessageSquare,
  RotateCcw,
  Search,
  ShieldAlert,
  Square,
  Timer,
  Workflow,
} from 'lucide-react';
import { Streamdown } from 'streamdown';

import type { AnswerMode, ChatEvent, CitationView, ProjectSummary, TraceEvent } from '@localmind/protocol';

import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { Badge, Button, Empty, ErrorNote, Panel, ScoreBar, Stat } from '../components/ui';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../components/select';

/**
 * The chat view — the demonstration of how LocalMind answers.
 *
 * LAYOUT: three columns, not a bubble list. The interesting part of a RAG answer
 * is not the prose, it is *why* that prose exists. Trace and Sources are peers
 * of the answer rather than something behind a disclosure triangle, because the
 * whole product claim is that the reasoning is inspectable.
 *
 * MEASURE: the prose fills its panel edge to edge, and the *column* carries the
 * width limit instead (`max-w-5xl` below). This is the opposite of capping the
 * paragraph inside a full-width panel, which is what this view used to do and
 * which reads as a bug — a 1350px card with a 550px ribbon of text hugging its
 * left edge looks broken rather than restrained. Constraining the container
 * keeps the measure sane *and* lets the text fill what the user can see, and it
 * hands the surplus width to the trace column, which has long paths and
 * excerpts to show.
 *
 * SCOPE: retrieval can be narrowed to one ingested source. The picker sits in
 * the composer rather than in Settings because it changes the meaning of the
 * next answer, not a preference — and it is echoed on every turn card, so a
 * transcript read later still says what the question was asked against.
 */

interface ModeSpec {
  readonly mode: AnswerMode;
  readonly label: string;
  readonly stage: string;
  readonly icon: ReactNode;
  readonly blurb: string;
}

const MODES: readonly ModeSpec[] = [
  {
    mode: 'ask',
    label: 'Ask',
    stage: 'Ground',
    icon: <MessageSquare className="size-3.5" aria-hidden />,
    blurb: 'One retrieval, streamed answer, citations. Fastest.',
  },
  {
    mode: 'agent',
    label: 'Agent',
    stage: 'Delegate',
    icon: <Bot className="size-3.5" aria-hidden />,
    blurb: 'The model chooses what to search for, and reformulates after a miss.',
  },
  {
    mode: 'research',
    label: 'Research',
    stage: 'Verify',
    icon: <Workflow className="size-3.5" aria-hidden />,
    blurb: 'Plan, grade, self-correct, web fallback, verify. Slowest, checked.',
  },
];

const TRACE_ICONS: Record<TraceEvent['kind'], ReactNode> = {
  plan: <Workflow className="size-3" aria-hidden />,
  retrieve: <Search className="size-3" aria-hidden />,
  grade: <BadgeCheck className="size-3" aria-hidden />,
  rewrite: <ChevronRight className="size-3" aria-hidden />,
  web: <Globe className="size-3" aria-hidden />,
  generate: <MessageSquare className="size-3" aria-hidden />,
  verify: <ShieldAlert className="size-3" aria-hidden />,
  repair: <ChevronRight className="size-3" aria-hidden />,
  step: <Bot className="size-3" aria-hidden />,
  done: <BadgeCheck className="size-3" aria-hidden />,
};

const TRACE_TONES: Record<NonNullable<TraceEvent['tone']>, string> = {
  neutral: 'text-muted',
  good: 'text-accent',
  warn: 'text-warn',
  bad: 'text-danger',
};

type DoneEvent = Extract<ChatEvent, { type: 'done' }>;

interface Turn {
  readonly id: string;
  readonly question: string;
  readonly mode: AnswerMode;
  /** The scope the question was asked under. Empty means the whole corpus. */
  readonly scope: string;
  /** Wall-clock start, so elapsed time can be shown while the answer streams. */
  readonly startedAt: number;
  /** Set when the user stopped it. Distinct from an error — nothing went wrong. */
  cancelled?: boolean;
  answer: string;
  trace: TraceEvent[];
  citations: readonly CitationView[];
  done?: DoneEvent;
  error?: { code: string; message: string; remedy: string };
  streaming: boolean;
}

/**
 * Render `[S1]` markers as citation links.
 *
 * Done as a text transform before Streamdown rather than a custom renderer
 * because the markers arrive mid-token during streaming; rewriting them to an
 * inline element keeps them legible while the surrounding sentence is still
 * being written.
 *
 * These are anchors, not decorated spans. `[S3]` is a reference, and a reference
 * you cannot follow is just noise in the middle of a sentence — the whole claim
 * of the product is that the grounding is *checkable*, so the marker has to take
 * you to the passage. `href` keeps it keyboard-reachable and focusable for free;
 * the click is intercepted (see `jumpToCitation`) so it scrolls and highlights
 * instead of teleporting the scroll position with no explanation.
 */
function withCitationChips(markdown: string, knownLabels: readonly string[] = []): string {
  const known = new Set(knownLabels);

  let text = markdown
    /*
     * Punctuation variants first. The server normalises the *settled* answer,
     * but `ask` mode renders token deltas as they arrive — so mid-stream this is
     * the only thing standing between the user and a raw 【S6】 sitting in the
     * middle of a sentence. This mirrors `normaliseCitationMarkers` in the
     * library, which applies the same rules at the audit layer where they decide
     * groundedness. Both are needed: one for what is displayed while streaming,
     * one for what is scored when it finishes.
     */
    .replace(/[\u3010\u3014\uFF3B\uFF08]\s*(S\d+(?:\s*[,;\u3001]\s*S\d+)*)\s*[\u3011\u3015\uFF3D\uFF09]/gu, '[$1]')
    .replace(/\((S\d+(?:\s*[,;]\s*S\d+)*)\)/gu, '[$1]')
    // `[S1, S2]` -> `[S1][S2]`, so a grouped citation renders as two chips
    // rather than one unmatched literal.
    .replace(/\[\s*(S\d+(?:\s*[,;\u3001]\s*S\d+)+)\s*\]/gu, (_match, group: string) =>
      (group.match(/S\d+/gu) ?? []).map((label) => `[${label}]`).join(''),
    )
    // `[ S1 ]` -> `[S1]`. Models pad the brackets often enough that leaving it
    // alone produced a chip with the model's literal brackets still either side
    // of it, because the tight pattern missed and the bare-label pass fired.
    .replace(/\[\s+(S\d+)\s+\]/gu, '[$1]');

  // Bare labels, gated on the citation table for this turn. Some models drop the
  // brackets entirely — "the primary order record table S1." — and without the
  // table there is no safe way to tell that from prose.
  if (known.size > 0) {
    text = text.replace(/(?<!\[\s{0,3})(?<![\w[])(S\d+)(?![\w\]])(?!\s{0,3}\])/gu, (match, label: string) =>
      known.has(label) ? `[${label}]` : match,
    );
  }

  /*
   * Emitted as a markdown LINK, not as raw HTML.
   *
   * The obvious implementation — splice an `<a class="lm-cite">` into the
   * string — silently does not work: Streamdown sanitises raw HTML out of the
   * markdown entirely, so the chips vanish and the marker renders as bare text.
   * `[S1](#lm-src-S1)` is plain markdown, which means it survives sanitisation,
   * renders as a real anchor, and gets a React component override
   * (`CITATION_COMPONENTS`) that owns the styling and the click. The href does
   * double duty as the jump target and as the discriminator for that override.
   */
  return text.replace(
    /\[\s*(S\d+)\s*\]/gu,
    (_match, label: string) => `[${label}](#${CITATION_HREF_PREFIX}${label})`,
  );
}

const CITATION_HREF_PREFIX = 'lm-src-';

/** Both places a citation can be shown: the side panel, and the small-screen list. */
function citationTargets(label: string): readonly (HTMLElement | null)[] {
  return [document.getElementById(`lm-src-${label}`), document.getElementById(`lm-isrc-${label}`)];
}

/**
 * Scroll a citation's source card into view, flash it, and open its excerpt.
 *
 * Done imperatively rather than through state because it is imperative work:
 * scrolling, restarting an animation, and opening a `<details>`. The *persistent*
 * highlight is React state (`focused` below) — the two are different things. The
 * flash says "here, just now"; the border says "this is the one you are looking
 * at", and it has to survive until the user picks another.
 *
 * `block: nearest` so a card already on screen does not cause a pointless jump.
 */
function jumpToCitation(label: string, origin?: HTMLElement): void {
  /*
   * Mark the tags imperatively, in the same pass as the scroll.
   *
   * The tag's `data-active` is also derived from React state, and normally that
   * would be enough — but Streamdown memoises each rendered markdown *block*,
   * and its memo does not consider the `components` override. So handing it a
   * new override on click does not re-render blocks it has already produced, and
   * the tag keeps its old attribute while the source card (plain React) updates.
   *
   * Both paths compute the same value from the same `focused` label, so this is
   * belt-and-braces rather than a second source of truth. Scoped to the
   * containing `<article>` so clicking a tag in one turn does not light up the
   * same label in another, where it means a different passage.
   */
  if (origin !== undefined) {
    const scope = origin.closest('article') ?? document;
    for (const tag of scope.querySelectorAll<HTMLElement>('button.lm-cite')) {
      const active = tag.textContent?.trim() === label;
      tag.dataset['active'] = active ? 'true' : 'false';
      tag.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  const target = citationTargets(label).find((element): element is HTMLElement => element !== null);
  if (target === undefined) return;

  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // Re-triggering a CSS animation requires removing the class, forcing a
  // reflow, then re-adding it. Without the reflow read, clicking the same
  // citation twice does nothing the second time.
  target.classList.remove('lm-flash');
  void target.offsetWidth;
  target.classList.add('lm-flash');

  // Opening the excerpt means the passage backing the claim is visible on
  // arrival rather than one more click away.
  target.querySelector('details')?.setAttribute('open', '');
}

/**
 * Anchor override for rendered answers.
 *
 * Three cases, and each one matters:
 *
 *  - A citation (`#lm-src-S1`) becomes the chip, and clicking it scrolls to the
 *    passage instead of jumping the scroll position with no explanation.
 *  - `streamdown:incomplete-link` is what Streamdown emits for a link whose
 *    markdown is still arriving. Rendering it as an anchor makes a half-written
 *    `[S1](#lm-` flash as a broken chip on nearly every token; rendering the
 *    text plainly means the chip simply appears once the marker is complete.
 *  - Anything else is a real link from the source document, and opens in a new
 *    tab with `noreferrer` — this content came from a model, so it is untrusted.
 */
function makeCitationComponents(
  onCite: (label: string, origin: HTMLElement) => void,
  focused: string | null,
): { a: (props: { href?: string; children?: ReactNode }) => ReactNode } {
  return {
    a: ({ href, children, ...rest }) => {
      if (href !== undefined && href.startsWith(`#${CITATION_HREF_PREFIX}`)) {
        const label = href.slice(CITATION_HREF_PREFIX.length + 1);
        return (
          // A <button>, not an <a>. This does not navigate anywhere — it focuses
          // an element already on the page — and rendering it as a link was
          // actively wrong twice over: it read as "this will take you off-site",
          // and it tripped Streamdown's external-link confirmation modal.
          <button
            type="button"
            className="lm-cite"
            // Styled by CSS off the attribute rather than a conditional class,
            // so the two ends of the relationship — tag and source card — stay
            // described in one place.
            data-active={focused === label ? 'true' : 'false'}
            aria-pressed={focused === label}
            title={`Show source ${label}`}
            aria-label={`Show source ${label}`}
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              onCite(label, event.currentTarget);
            }}
          >
            {children}
          </button>
        );
      }

      // Streamdown emits this href while a link's markdown is still arriving.
      // Rendering it as an anchor makes a half-written marker flash as a broken
      // chip on nearly every token.
      if (href === 'streamdown:incomplete-link') return <span>{children}</span>;

      return (
        <a href={href} target="_blank" rel="noreferrer" {...rest}>
          {children}
        </a>
      );
    },
  };
}

/**
 * Link-safety configuration.
 *
 * Streamdown guards links in model output behind a confirmation modal, which is
 * right: an answer can quote a URL out of an ingested document, and that
 * document may have come from a public repository. But the modal was firing on
 * the in-page `#lm-src-S1` citation anchors too — asking the user to confirm
 * navigation to a place they were already standing, in a card styled with
 * shadcn class names this theme does not define, so it rendered as an unstyled
 * white-bordered box.
 *
 * `onLinkCheck` returns true for same-page fragments and leaves every real URL
 * to the prompt. Fixing it by disabling link safety wholesale would have traded
 * a cosmetic bug for a security one.
 */
const LINK_SAFETY = {
  enabled: true,
  onLinkCheck: (url: string): boolean => url.startsWith('#'),
} as const;

/*
 * Sentinel for "no scope", NOT the empty string.
 *
 * Radix Select reserves `value=""` to mean "nothing selected" — an item carrying
 * it is treated as a placeholder reset, so the trigger renders the placeholder
 * text instead of the item label. The whole-corpus option therefore needs a real
 * value, and it is stripped before the request is sent rather than travelling to
 * the server as a magic string.
 */
const ALL_SOURCES = '__all__';

/**
 * A ticking elapsed-milliseconds value, or `undefined` when nothing is running.
 *
 * Worth an interval: `research` mode routinely spends 30-60 seconds across plan,
 * retrieve, grade, generate and verify, and a spinner with no number attached is
 * indistinguishable from a hang. Watching the count climb is the whole
 * difference between "it is working" and "it is stuck".
 *
 * 100ms rather than per-frame, because the display is rounded to a tenth of a
 * second and anything faster re-renders for digits that cannot have changed.
 */
function useElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);

  return startedAt === undefined ? undefined : Math.max(0, now - startedAt);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ChatView({ corpusEmpty }: { corpusEmpty: boolean }): ReactNode {
  const [mode, setMode] = useState<AnswerMode>('ask');
  const [scope, setScope] = useState<string>(ALL_SOURCES);
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  /** The citation the user last clicked, kept highlighted in the sources panel. */
  const [focused, setFocused] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = turns[turns.length - 1];

  // The scope options. Loaded once on mount: this view is unmounted on tab
  // change, so remounting is already the refresh, and polling a list that only
  // changes when the user ingests something would be noise.
  useEffect(() => {
    let cancelled = false;
    void api
      .projects()
      .then((response) => {
        if (!cancelled) setProjects(response.projects);
      })
      .catch(() => {
        // A failed project list must not break asking questions — it only costs
        // the scope picker, and the whole-corpus default still works.
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A scope whose source was deleted while the tab was open would be sent to the
  // server and rejected. Fall back to the whole corpus instead.
  useEffect(() => {
    if (projects === null || scope === ALL_SOURCES) return;
    if (!projects.some((project) => project.sourceRef === scope)) setScope(ALL_SOURCES);
  }, [projects, scope]);

  // Follow the stream, but only while the user is already near the bottom.
  // Yanking the viewport away from someone reading earlier output is worse than
  // not auto-scrolling at all.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 220) element.scrollTo({ top: element.scrollHeight });
  }, [active?.answer, active?.trace.length]);

  /**
   * Run one question.
   *
   * Takes question, mode and scope as arguments rather than reading state,
   * because Retry has to re-run a *previous* turn as it was originally asked —
   * with that turn's mode and scope, not whatever the composer happens to show
   * now. Reading state here is the bug where retrying a failed research question
   * silently re-asks it in ask mode against the whole corpus.
   */
  const run = useCallback(async (text: string, turnMode: AnswerMode, turnScope: string) => {
    if (text.length === 0) return;

    const id = `${Date.now()}`;
    const startedAt = Date.now();
    setBusy(true);
    setTurns((previous) => [
      ...previous,
      {
        id,
        question: text,
        mode: turnMode,
        scope: turnScope,
        startedAt,
        answer: '',
        trace: [],
        citations: [],
        streaming: true,
      },
    ]);

    setFocused(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const patch = (update: (turn: Turn) => Turn): void => {
      setTurns((previous) => previous.map((turn) => (turn.id === id ? update(turn) : turn)));
    };

    try {
      const request = {
        question: text,
        mode: turnMode,
        ...(turnScope !== ALL_SOURCES ? { sourceRef: turnScope } : {}),
      };

      for await (const event of api.chat(request, controller.signal)) {
        switch (event.type) {
          case 'sources':
            patch((turn) => ({ ...turn, citations: event.citations }));
            break;
          case 'trace':
            patch((turn) => ({ ...turn, trace: [...turn.trace, event.event] }));
            break;
          case 'delta':
            patch((turn) => ({ ...turn, answer: turn.answer + event.text }));
            break;
          case 'done':
            patch((turn) => ({
              ...turn,
              // `ask` streamed its answer already; the others deliver it whole.
              answer: turn.answer.length > 0 ? turn.answer : event.answer,
              done: event,
              streaming: false,
            }));
            break;
          case 'error':
            patch((turn) => ({ ...turn, error: event, streaming: false }));
            break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // A user-initiated stop is not a failure. Labelling it as one teaches
        // people that pressing Stop breaks something, so they stop pressing it.
        patch((turn) => ({ ...turn, cancelled: true, streaming: false }));
      } else {
        const payload =
          error instanceof ApiError
            ? { code: error.code, message: error.message, remedy: error.remedy }
            : { code: 'NETWORK', message: String(error), remedy: 'Is the API process running?' };
        patch((turn) => ({ ...turn, error: payload, streaming: false }));
      }
    } finally {
      patch((turn) => ({ ...turn, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }, []);

  const submit = useCallback(() => {
    const text = question.trim();
    if (text.length === 0 || busy) return;
    setQuestion('');
    void run(text, mode, scope);
  }, [busy, mode, question, run, scope]);

  /**
   * Re-ask a turn. Appends a new turn rather than mutating the failed one, so
   * the transcript keeps the evidence of what went wrong — useful when the first
   * attempt failed for a reason the second one hides.
   */
  const retry = useCallback(
    (turn: Turn) => {
      if (busy) return;
      void run(turn.question, turn.mode, turn.scope);
    },
    [busy, run],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
  }, []);

  const onCite = useCallback((label: string, origin?: HTMLElement) => {
    setFocused(label);
    jumpToCitation(label, origin);
  }, []);

  const spec = MODES.find((entry) => entry.mode === mode) ?? MODES[0];

  // Resolved once: the composer uses it for the placeholder and the scope note,
  // and each turn card uses its own recorded scope.
  const scopeLabel =
    scope === ALL_SOURCES
      ? undefined
      : ((projects ?? []).find((project) => project.sourceRef === scope)?.label ?? scope);

  // One ticking clock for the view, keyed on the streaming turn. Passing the
  // value down means the card and the composer cannot disagree about how long
  // the request has been running, which two independent timers eventually would.
  const elapsed = useElapsed(active?.streaming === true ? active.startedAt : undefined);

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      {/* ── conversation ─────────────────────────────────────────────────── */}
      {/*
        `max-w-5xl` (64rem) is the measure control for the whole view. The
        answer prose then fills its panel completely — see the note at the top of
        this file for why the limit belongs here and not on the paragraph.
      */}
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-col gap-3">
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1"
          // The live region is the transcript, so a screen reader hears the
          // answer arrive without focus being moved off the composer.
          aria-live="polite"
          aria-busy={busy || undefined}
        >
          {turns.length === 0 ? (
            <Empty
              icon={<MessageSquare className="size-8" />}
              title={corpusEmpty ? 'Your corpus is empty' : 'Ask a question about your corpus'}
              hint={
                corpusEmpty
                  ? 'Add a document in Corpus, or point the analyzer at a repository in Sources. Then come back here.'
                  : 'Try one question in all three modes: Ask retrieves once, Agent reformulates, Research grades and verifies.'
              }
            />
          ) : (
            turns.map((turn) => (
              <TurnCard
                key={turn.id}
                turn={turn}
                onRetry={() => retry(turn)}
                retryDisabled={busy}
                onCite={onCite}
                focused={focused}
                {...(turn.streaming && elapsed !== undefined ? { elapsed } : {})}
                onCancel={stop}
                scopeLabel={
                  turn.scope === ALL_SOURCES
                    ? undefined
                    : ((projects ?? []).find((project) => project.sourceRef === turn.scope)?.label ?? turn.scope)
                }
              />
            ))
          )}
        </div>

        {/* ── composer ───────────────────────────────────────────────────── */}
        {/*
          COMPOSER LAYOUT — three rows, grouped by what each one is for.
          The previous version stacked five: chips, blurb+scope, scope warning,
          input, hint. Five rows of near-equal weight is not a hierarchy, it is a
          list, and the eye has nowhere to land.

            1. controls — mode on the left, scope on the right. Both change what
               the next question does, so they belong on one line together.
            2. input    — the field and the single primary action, unshared.
            3. meta     — what the mode does, and the keyboard hint. Both are
               reference text, so they collapse into one dim row instead of
               bracketing the input from above and below.
        */}
        <div className="lm-lift shrink-0 space-y-2.5 rounded-panel border border-line-soft bg-surface p-3">
          {/* ── 1. controls ──────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/*
              A segmented control, not three loose pills. The modes are one
              mutually exclusive choice, and a shared track with hairline
              dividers says that at a glance — where three separately-bordered
              buttons read as three independent toggles.
            */}
            <div
              role="radiogroup"
              aria-label="Answering mode"
              className="flex shrink-0 items-center gap-0.5 rounded-control border border-line-soft bg-inset p-0.5"
            >
              {MODES.map((entry) => {
                const selected = mode === entry.mode;
                return (
                  <button
                    key={entry.mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setMode(entry.mode)}
                    title={entry.blurb}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1.5 px-2.5',
                      'text-xs transition-colors duration-200 ease-out-soft',
                      selected
                        ? 'bg-accent/15 font-semibold text-accent shadow-[inset_0_1px_0_oklch(1_0_0/0.06)]'
                        : 'font-medium text-muted hover:bg-raised/60 hover:text-fg',
                    )}
                  >
                    {entry.icon}
                    {entry.label}
                    <span
                      className={cn(
                        'hidden font-mono text-[10px] lg:inline',
                        selected ? 'text-accent/70' : 'text-faint',
                      )}
                    >
                      {entry.stage}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1" />

            {/* ── scope ─────────────────────────────────────────────────── */}
            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <Layers
                className={cn('size-3.5 shrink-0', scope === ALL_SOURCES ? 'text-muted' : 'text-accent')}
                aria-hidden
              />
              <Select value={scope} onValueChange={setScope} disabled={projects === null}>
                <SelectTrigger
                  aria-label="Restrict retrieval to one ingested project"
                  className={cn(
                    'w-56 font-mono text-xs',
                    scope === ALL_SOURCES ? '' : 'border-accent/45 bg-accent/10 text-accent',
                  )}
                >
                  <SelectValue placeholder="loading projects…" />
                </SelectTrigger>
                <SelectContent className="max-w-[22rem]">
                  <SelectGroup>
                    <SelectItem value={ALL_SOURCES} className="font-mono text-xs">
                      entire corpus
                    </SelectItem>
                  </SelectGroup>
                  {(projects ?? []).length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>one project</SelectLabel>
                      {(projects ?? []).map((project) => (
                        <SelectItem key={project.sourceRef} value={project.sourceRef} className="font-mono text-xs">
                          <span className="truncate">{project.label}</span>
                          <span className="ml-auto shrink-0 pl-3 text-[10px] tnum text-faint">
                            {project.documents}d · {project.chunks}c
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ── 2. input ─────────────────────────────────────────────────── */}
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor="lm-question">
              Question
            </label>
            <textarea
              id="lm-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder={
                scope === ALL_SOURCES
                  ? 'Ask about your indexed documents…'
                  : `Ask about ${scopeLabel ?? 'this project'}…`
              }
              aria-describedby="lm-question-hint"
              className={cn(
                'min-h-[3.25rem] flex-1 resize-none rounded-control border border-line-soft bg-inset',
                'px-3 py-2 text-sm leading-relaxed text-fg placeholder:text-faint',
                'transition-colors duration-200 hover:border-line focus:border-accent focus:outline-none',
              )}
            />
            {busy ? (
              // Always available: an in-flight request the user cannot stop is
              // the one state this UI must never have. The clock lives on the
              // button so the wait and the way out are the same target.
              <Button variant="outline" onClick={stop} className="h-[3.25rem] px-3.5" aria-label="Cancel this request">
                <Square className="size-3.5" aria-hidden />
                Cancel
                {elapsed !== undefined ? (
                  <span className="font-mono text-xs tnum text-muted">{formatSeconds(elapsed)}</span>
                ) : null}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={submit}
                disabled={question.trim().length === 0}
                aria-label="Send question"
                className="h-[3.25rem] px-3.5"
              >
                <ArrowUp className="size-4" aria-hidden />
              </Button>
            )}
          </div>

          {/* ── 3. meta ──────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5">
            {/*
              A narrowed scope is stated here rather than in a banner of its own.
              It is the one setting in this view that can make a correct answer
              look wrong — "not in the corpus" and "not in this project" are
              different conclusions — so it has to be visible, but it does not
              warrant its own row.
            */}
            {scope !== ALL_SOURCES ? (
              <span className="text-xs leading-snug text-accent">
                Limited to <span className="font-mono">{scopeLabel}</span> — anything outside it is invisible to the
                answer.
              </span>
            ) : (
              <span className="min-w-0 flex-1 text-xs leading-snug text-muted">{spec?.blurb}</span>
            )}
            <span id="lm-question-hint" className="ml-auto shrink-0 font-mono text-[11px] text-faint">
              Enter to send · Shift+Enter for a newline
            </span>
          </div>
        </div>
      </div>

      {/* ── trace + sources ──────────────────────────────────────────────── */}
      <div className="hidden min-h-0 flex-col gap-3 lg:flex">
        <TracePanel turn={active} />
        <SourcesPanel turn={active} focused={focused} onCite={onCite} />
      </div>
    </div>
  );
}

/* ── panels ──────────────────────────────────────────────────────────────── */

function TracePanel({ turn }: { turn: Turn | undefined }): ReactNode {
  return (
    <Panel title="Pipeline" className="max-h-[42%]" bodyClassName="p-3" busy={turn?.streaming}>
      {turn === undefined || turn.trace.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          Each phase appears here as the answer is produced — retrieval, grading, rewrites, verification.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {turn.trace.map((event, index) => (
            <li key={index} className="lm-enter flex gap-2 text-xs leading-snug">
              <span className={cn('mt-0.5 shrink-0', TRACE_TONES[event.tone ?? 'neutral'])}>
                {TRACE_ICONS[event.kind]}
              </span>
              <span className="min-w-0">
                <span className="text-fg">{event.label}</span>
                {event.detail !== undefined ? (
                  <span className="lm-wrap-any block font-mono text-[10px] text-muted">{event.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function SourcesPanel({
  turn,
  focused,
  onCite,
}: {
  turn: Turn | undefined;
  /** The citation the user clicked in the answer, if any. */
  focused: string | null;
  onCite: (label: string, origin?: HTMLElement) => void;
}): ReactNode {
  const used = useMemo(() => new Set(turn?.done?.audit.used ?? []), [turn?.done]);

  return (
    <Panel
      title={`Sources${turn !== undefined && turn.citations.length > 0 ? ` · ${turn.citations.length}` : ''}`}
      className="min-h-0 flex-1"
      bodyClassName="p-3"
    >
      {turn === undefined || turn.citations.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted">
          Retrieved passages appear here with their relevance score, labelled as the model cites them. Clicking an{' '}
          <span className="lm-cite">S1</span> marker in an answer jumps to the passage behind it.
        </p>
      ) : (
        <ul className="space-y-2">
          {turn.citations.map((citation) => {
            const cited = used.has(citation.label);
            const isFocused = focused === citation.label;
            return (
              <li
                key={citation.label + citation.chunkId}
                // The jump target for `[S1]` in the answer. `scroll-mt` keeps
                // the card clear of the sticky panel header after the scroll.
                id={`lm-src-${citation.label}`}
                aria-current={isFocused ? 'true' : undefined}
                className={cn(
                  'scroll-mt-3 rounded-control border p-2.5 transition-colors duration-200',
                  // Three states, not two, and they have to stay distinguishable:
                  //   focused — the citation you just clicked (full accent border + ring)
                  //   cited   — appears somewhere in the answer (tinted)
                  //   neither — retrieved but unused
                  // Focus wins, because it answers the question the user just
                  // asked by clicking, and it persists until they click another.
                  isFocused
                    ? 'border-accent bg-accent/12 ring-1 ring-accent/45'
                    : cited
                      ? 'border-accent/35 bg-accent/6'
                      : 'border-line-soft bg-inset/40',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={(event) => onCite(citation.label, event.currentTarget)}
                    className="cursor-pointer rounded"
                    aria-label={`Highlight source ${citation.label}`}
                  >
                    <Badge tone={isFocused || cited ? 'accent' : 'neutral'}>{citation.label}</Badge>
                  </button>
                  {citation.origin === 'web' ? (
                    <Badge tone="info">
                      <Globe className="size-2.5" aria-hidden />
                      web
                    </Badge>
                  ) : (
                    <ScoreBar score={citation.score} />
                  )}
                </div>

                <p className="mt-1.5 text-xs font-medium leading-snug text-fg">{citation.title}</p>
                {citation.headingPath.length > 0 ? (
                  <p className="truncate text-[10px] text-muted">{citation.headingPath}</p>
                ) : null}
                <p className="lm-wrap-any mt-1 font-mono text-[10px] text-muted">{citation.relativePath}</p>

                {citation.excerpt !== undefined ? (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer font-mono text-[10px] text-muted hover:text-fg">
                      excerpt
                    </summary>
                    <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-line-soft bg-bg/60 p-2 text-xs leading-relaxed text-muted">
                      {citation.excerpt}
                    </p>
                  </details>
                ) : null}
              </li>
            );
          })}
          {/* `cited` is carried by colour AND the chip tone AND position, never
              colour alone. */}
          <li className="pt-1 font-mono text-[10px] leading-relaxed text-muted">
            tinted = cited in the answer · outlined = the tag you clicked
          </li>
        </ul>
      )}
    </Panel>
  );
}

/* ── one question + answer ───────────────────────────────────────────────── */

function TurnCard({
  turn,
  scopeLabel,
  elapsed,
  onCancel,
  onRetry,
  retryDisabled = false,
  onCite,
  focused,
}: {
  turn: Turn;
  scopeLabel?: string;
  /** Ticking wall-clock, present only while this turn is streaming. */
  elapsed?: number;
  onCancel: () => void;
  onRetry: () => void;
  retryDisabled?: boolean;
  onCite: (label: string, origin?: HTMLElement) => void;
  focused: string | null;
}): ReactNode {
  const done = turn.done;
  const modeSpec = MODES.find((entry) => entry.mode === turn.mode);
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

  // Memoised on `onCite`, which is itself stable — so the override object does
  // not change identity every render and force Streamdown to re-render the whole
  // answer on each streamed token.
  // `onCite` is stable, so this only changes identity when the focused citation
  // does — a discrete click, never a streamed token. Streaming therefore does not
  // re-render the whole answer on every delta.
  const components = useMemo(() => makeCitationComponents(onCite, focused), [onCite, focused]);

  return (
    <article className="lm-enter space-y-2.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded border border-line-soft bg-inset font-mono text-[10px] text-muted">
          Q
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-fg">{turn.question}</p>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {/* The scope is recorded per turn, so scrolling back through a session
              still says what each question was asked against. */}
          {scopeLabel !== undefined ? (
            <Badge tone="info" title={`Retrieval was limited to ${scopeLabel}`}>
              <Layers className="size-2.5" aria-hidden />
              {scopeLabel}
            </Badge>
          ) : null}
          <Badge tone="accent">{modeSpec?.label}</Badge>
        </div>
      </div>

      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'relative mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-accent/15 text-accent',
            turn.streaming ? 'lm-live' : '',
          )}
        >
          <Bot className="size-3.5" aria-hidden />
        </span>

        <div className="min-w-0 flex-1 space-y-2.5">
          {turn.error !== undefined ? (
            <div className="space-y-2">
              <ErrorNote code={turn.error.code} message={turn.error.message} remedy={turn.error.remedy} />
              {/*
                The recovery path, next to the thing that failed. An error with a
                remedy the user has to act on somewhere else is only half an
                error message — Retry re-asks this exact question in the mode and
                scope it was originally asked under.
              */}
              <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled}>
                <RotateCcw className="size-3.5" aria-hidden />
                Retry this question
              </Button>
            </div>
          ) : null}

          {/* Stopped by the user: stated plainly, and offered again. */}
          {turn.cancelled === true ? (
            <div className="flex flex-wrap items-center gap-2.5 rounded-control border border-line-soft bg-inset/40 px-3 py-2">
              <Badge tone="warn">
                <Square className="size-2.5" aria-hidden />
                cancelled
              </Badge>
              <span className="min-w-0 flex-1 text-xs text-muted">
                You stopped this request{turn.answer.length > 0 ? ' — the partial answer above is kept' : ''}.
              </span>
              <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled}>
                <RotateCcw className="size-3.5" aria-hidden />
                Ask again
              </Button>
            </div>
          ) : null}

          {/* A stable skeleton, not a bare spinner: it reserves the layout the
              answer will occupy, so nothing jumps when text arrives. */}
          {turn.answer.length === 0 && turn.streaming ? (
            <div className="lm-lift space-y-2.5 rounded-panel border border-line-soft bg-surface/60 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <p className="min-w-0 flex-1 font-mono text-[11px] text-muted">
                  {turn.mode === 'ask' ? 'retrieving…' : turn.mode === 'agent' ? 'the agent is working…' : 'planning…'}
                </p>
                <ElapsedChip elapsed={elapsed} mode={turn.mode} />
                <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel this request">
                  <Square className="size-3" aria-hidden />
                  Cancel
                </Button>
              </div>
              <div className="lm-skeleton h-3 w-11/12" />
              <div className="lm-skeleton h-3 w-4/5" />
              <div className="lm-skeleton h-3 w-2/3" />
            </div>
          ) : null}

          {/*
            Once tokens are arriving the skeleton is gone, but the request is
            still running — so the clock and the cancel control have to survive
            past it. Without this, a long research answer streams its first
            paragraph and then appears to hang with no way out.
          */}
          {turn.answer.length > 0 && turn.streaming ? (
            <div className="flex items-center gap-2.5">
              <ElapsedChip elapsed={elapsed} mode={turn.mode} />
              <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel this request">
                <Square className="size-3" aria-hidden />
                Cancel
              </Button>
            </div>
          ) : null}

          {turn.answer.length > 0 ? (
            <div className="lm-lift rounded-panel border border-line-soft bg-surface">
              <div className="flex items-center justify-between border-b border-line-soft px-4 py-2.5 bg-inset/50">
                <span className="font-mono text-[10px] text-muted">Answer</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowRawMarkdown((v) => !v)}
                  aria-label={showRawMarkdown ? 'Switch to rendered markdown' : 'Switch to raw markdown'}
                  className="text-muted hover:text-fg"
                >
                  {showRawMarkdown ? (
                    <FileText className="size-3.5" aria-hidden />
                  ) : (
                    <Code className="size-3.5" aria-hidden />
                  )}
                </Button>
              </div>
              <div className="px-5 py-4">
                {showRawMarkdown ? (
                  <pre className="font-mono text-[12px] leading-relaxed text-fg whitespace-pre-wrap overflow-x-auto">
                    <code>{turn.answer}</code>
                  </pre>
                ) : (
                  <Streamdown
                    className="lm-markdown"
                    mode={turn.streaming ? 'streaming' : 'static'}
                    parseIncompleteMarkdown
                    components={components}
                    linkSafety={LINK_SAFETY}
                    controls={{ code: true, table: true, mermaid: true }}
                  >
                    {withCitationChips(
                      turn.answer,
                      turn.citations.map((citation) => citation.label),
                    )}
                  </Streamdown>
                )}
              </div>
            </div>
          ) : null}

          {/*
            Below `lg` the trace/sources column is not rendered, which would make
            every citation link in the answer a dead anchor. This is the same
            data in a disclosure, with the `lm-isrc-` ids the jump handler falls
            back to.
          */}
          {turn.citations.length > 0 ? (
            <details className="rounded-control border border-line-soft bg-inset/40 lg:hidden">
              <summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-muted hover:text-fg">
                {turn.citations.length} source(s)
              </summary>
              <ul className="space-y-1.5 px-3 pb-3">
                {turn.citations.map((citation) => (
                  <li
                    key={citation.label + citation.chunkId}
                    id={`lm-isrc-${citation.label}`}
                    className={cn(
                      'scroll-mt-3 rounded border bg-bg/50 p-2 transition-colors duration-200',
                      focused === citation.label ? 'border-accent ring-1 ring-accent/40' : 'border-line-soft',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Badge tone="accent">{citation.label}</Badge>
                      <span className="min-w-0 flex-1 truncate text-xs text-fg">{citation.title}</span>
                    </div>
                    {citation.excerpt !== undefined ? (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer font-mono text-[10px] text-muted">excerpt</summary>
                        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
                          {citation.excerpt}
                        </p>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {done !== undefined ? <AnswerFooter done={done} /> : null}
        </div>
      </div>
    </article>
  );
}

/**
 * The live clock.
 *
 * `aria-live="off"` on purpose: this updates ten times a second, and a polite
 * live region would queue a hundred announcements a second-and-a-half. The
 * transcript region already announces the answer itself, which is the part a
 * screen-reader user needs — a timer read aloud continuously is noise that
 * drowns it out. `role="timer"` still exposes it for anyone who navigates to it.
 */
function ElapsedChip({ elapsed, mode }: { elapsed?: number; mode: AnswerMode }): ReactNode {
  // Research mode is expected to be slow; the others are not. Crossing the
  // threshold turns the chip amber, which is the honest signal that this is
  // taking longer than it should rather than a promise that it will finish.
  const slowAfterMs = mode === 'research' ? 75_000 : mode === 'agent' ? 45_000 : 20_000;
  const slow = elapsed !== undefined && elapsed > slowAfterMs;

  return (
    <span
      role="timer"
      aria-live="off"
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] tnum leading-none',
        slow ? 'border-warn/35 bg-warn/12 text-warn' : 'border-line-soft bg-inset text-muted',
      )}
      title={slow ? 'This is taking longer than this mode usually does.' : 'Time since the request started'}
    >
      <Timer className="size-2.5" aria-hidden />
      {elapsed === undefined ? '0.0s' : formatSeconds(elapsed)}
    </span>
  );
}

function AnswerFooter({ done }: { done: DoneEvent }): ReactNode {
  const verification = done.verification;
  const uncited = done.audit.uncitedSentences.length;
  const invented = done.audit.unknown.length;

  return (
    <div className="space-y-2.5 rounded-control border border-line-soft bg-inset/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {done.abstained ? (
          <Badge tone="warn">
            <CircleSlash className="size-2.5" aria-hidden />
            abstained
          </Badge>
        ) : null}

        {verification !== undefined ? (
          <Badge tone={verification.grounded ? 'accent' : verification.confident ? 'danger' : 'warn'}>
            {verification.grounded ? (
              <BadgeCheck className="size-2.5" aria-hidden />
            ) : (
              <ShieldAlert className="size-2.5" aria-hidden />
            )}
            {verification.grounded ? 'grounded' : verification.confident ? 'not grounded' : 'unverified'}
          </Badge>
        ) : null}

        {done.repaired === true ? <Badge tone="warn">repaired</Badge> : null}
        {done.stopReason !== undefined ? (
          <Badge tone={done.stopReason === 'final-answer-tool' ? 'accent' : 'warn'}>{done.stopReason}</Badge>
        ) : null}
        {invented > 0 ? <Badge tone="danger">{invented} invented label(s)</Badge> : null}
        {uncited > 0 ? <Badge tone="warn">{uncited} uncited claim(s)</Badge> : null}
        {invented === 0 && uncited === 0 && !done.abstained ? <Badge tone="accent">citations clean</Badge> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="cited" value={done.audit.used.length > 0 ? done.audit.used.join(' ') : '—'} />
        <Stat label="tokens in/out" value={`${done.usage.inputTokens}/${done.usage.outputTokens}`} />
        <Stat label="elapsed" value={`${(done.durationMs / 1000).toFixed(1)}s`} />
        {done.confidence !== undefined ? (
          <Stat
            label="confidence"
            value={done.confidence}
            {...(done.confidence === 'high' ? { tone: 'accent' as const } : { tone: 'warn' as const })}
          />
        ) : done.phases !== undefined ? (
          <Stat label="phases" value={String(done.phases.length)} />
        ) : (
          <Stat label="mode" value={done.mode} />
        )}
      </div>

      {verification !== undefined && !verification.grounded ? (
        <div className="space-y-1.5 border-t border-line-soft pt-2">
          <p className="text-xs leading-relaxed text-warn">{verification.reason}</p>
          {verification.unsupportedClaims.slice(0, 3).map((claim, index) => (
            <p key={index} className="text-xs leading-snug text-muted">
              <span className="font-mono text-muted">[{claim.problem}]</span> {claim.claim.slice(0, 160)}
            </p>
          ))}
        </div>
      ) : null}

      {done.subQueries !== undefined && done.subQueries.length > 0 ? (
        <div className="space-y-1.5 border-t border-line-soft pt-2">
          {done.subQueries.map((outcome, index) => (
            <div key={index} className="flex items-start gap-2 text-[11px]">
              <Badge tone={outcome.resolved ? 'accent' : outcome.usedWebFallback ? 'info' : 'danger'}>
                {outcome.resolved ? 'resolved' : outcome.usedWebFallback ? 'web' : 'unresolved'}
              </Badge>
              <span className="min-w-0 flex-1">
                <span className="text-fg">{outcome.query}</span>
                <span className="lm-wrap-any block font-mono text-[10px] tnum text-muted">
                  {outcome.attempts
                    .map(
                      (attempt) =>
                        `${attempt.retrieved} retrieved → ${attempt.grade.relevantCount}R/${attempt.grade.partialCount}P/${attempt.grade.irrelevantCount}I`,
                    )
                    .join('  ·  ')}
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
