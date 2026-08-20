import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { useEffect, useId, useRef } from 'react';
import { Loader2, X } from 'lucide-react';

import { cn } from '../lib/cn';

/**
 * The component primitives.
 *
 * Hand-rolled rather than pulled from a component library, for one reason: this
 * UI ships *inside* a published package. A component-library dependency would
 * leak into every consumer's bundle and force their Tailwind config to match
 * ours. These are the primitives the Studio actually uses, all styling over
 * native elements — so accessibility comes from the platform rather than from a
 * roving-tabindex implementation we would have to maintain.
 *
 * Design language: Minimalism / Swiss on the shadcn `b78kmlQqEl` palette. One
 * accent (green, reading as "run / verified"), visible borders, mono for machine
 * output and sans for prose, 220ms transitions, and focus rings never removed.
 */

/* ── Button ──────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  /*
   * `bg-primary text-primary-fg`, not `bg-accent text-bg`.
   *
   * The shadcn preset's `--primary` is a DARK green (#016630) that needs light
   * type on it — 6.78:1 with its paired `--primary-foreground`. Reusing the
   * accent here instead would have been 8.95:1 as text but only 2.80:1 as a
   * fill under dark type, which is the exact inversion that makes a themed
   * button look right in a screenshot and fail a contrast check.
   */
  primary: 'bg-primary text-primary-fg font-semibold shadow-[inset_0_1px_0_oklch(1_0_0/0.12)] hover:brightness-125',
  ghost: 'text-muted hover:text-fg hover:bg-inset',
  outline: 'border border-line text-fg hover:bg-inset',
  danger: 'border border-danger/45 text-danger hover:bg-danger/10',
  subtle: 'bg-inset text-fg border border-line-soft hover:bg-raised hover:border-line',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  // Min height 32px at sm and 36px at md. Below 32px a pointer target starts
  // costing accuracy even on desktop, and these sit in dense toolbars.
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  icon: 'h-8 w-8 justify-center',
};

export function Button({
  variant = 'subtle',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}): ReactNode {
  return (
    <button
      {...rest}
      disabled={disabled === true || loading}
      // `aria-busy` rather than only a spinner glyph: assistive tech needs the
      // state, not the animation.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex cursor-pointer items-center rounded-control font-medium',
        'transition-colors duration-200 ease-out-soft',
        'disabled:cursor-not-allowed disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ── Inputs ──────────────────────────────────────────────────────────────── */

const FIELD_BASE =
  'w-full rounded-control bg-inset border border-line-soft px-3 text-sm text-fg ' +
  'placeholder:text-faint transition-colors duration-200 hover:border-line ' +
  'focus:border-accent focus:outline-none disabled:opacity-50';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...rest} className={cn(FIELD_BASE, 'h-9', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...rest} className={cn(FIELD_BASE, 'resize-none py-2 leading-relaxed', className)} />;
}

/**
 * A checkbox, including the tri-state a "select all" header needs.
 *
 * `indeterminate` is not an HTML attribute — it can only be set on the DOM node
 * — so it has to go through a ref. Skipping it is the usual shortcut, and it
 * produces the bug where selecting three of ten rows makes the header checkbox
 * read as "nothing selected"; clicking it then clears the three instead of
 * selecting the remaining seven. `aria-checked="mixed"` carries the same state
 * to assistive tech, which the native property does not do on its own.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  className,
  disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  /** Accessible name. Visually hidden — these sit in dense rows. */
  label: string;
  className?: string;
  disabled?: boolean;
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      aria-checked={indeterminate && !checked ? 'mixed' : checked}
      className={cn(
        'size-3.5 shrink-0 cursor-pointer accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
    />
  );
}

/**
 * A labelled field.
 *
 * The label is a real `<label>` bound by id, and helper text is wired through
 * `aria-describedby` — placeholder-only labelling and detached hints are the two
 * form failures that actually bite screen-reader users.
 */
export function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: (props: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean | undefined }) => ReactNode;
}): ReactNode {
  const id = useId();
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-baseline gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted">
        {label}
        {required === true ? (
          <span className="text-danger" aria-hidden>
            *
          </span>
        ) : null}
      </label>

      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error !== undefined || undefined })}

      {/* Error sits directly below the field it belongs to, not in a summary
          somewhere else on the page. */}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs leading-snug text-danger">
          {error}
        </p>
      ) : null}
      {hint !== undefined ? (
        <p id={hintId} className="text-xs leading-snug text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ── Badge ───────────────────────────────────────────────────────────────── */

type BadgeTone = 'neutral' | 'accent' | 'info' | 'warn' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-inset text-muted border-line-soft',
  accent: 'bg-accent/12 text-accent border-accent/35',
  info: 'bg-info/12 text-info border-info/35',
  warn: 'bg-warn/12 text-warn border-warn/35',
  danger: 'bg-danger/12 text-danger border-danger/35',
};

export function Badge({
  tone = 'neutral',
  mono = true,
  className,
  title,
  children,
}: {
  tone?: BadgeTone;
  /** Mono by default: a badge is nearly always machine output. */
  mono?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      {...(title !== undefined ? { title } : {})}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        mono ? 'font-mono' : '',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

export function Panel({
  title,
  actions,
  className,
  bodyClassName,
  busy,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  busy?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section
      aria-busy={busy || undefined}
      className={cn('lm-lift flex min-h-0 flex-col rounded-panel border border-line-soft bg-surface', className)}
    >
      {title !== undefined ? (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-3.5 py-2">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-3.5', bodyClassName)}>{children}</div>
    </section>
  );
}

/* ── Empty & skeleton states ─────────────────────────────────────────────── */

export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon !== undefined ? (
        <div className="text-faint" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint !== undefined ? <p className="max-w-sm text-xs leading-relaxed text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * Skeleton rows.
 *
 * Used instead of a centred spinner wherever the loaded content will occupy
 * layout, because a spinner that is replaced by a list causes a jump — the
 * content-jumping failure, and it is the most visible kind of jank in an app
 * that is mostly lists.
 */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }): ReactNode {
  return (
    <div className={cn('space-y-2', className)} aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="lm-skeleton h-9" style={{ opacity: 1 - index * 0.12 }} />
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return <Loader2 className={cn('size-4 animate-spin text-muted', className)} aria-hidden />;
}

/* ── Modal ───────────────────────────────────────────────────────────────── */

export function Modal({
  open,
  title,
  onClose,
  footer,
  wide = false,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      // Focus trap. Without it, Tab walks out of the dialog into the page
      // behind the scrim, which for a keyboard user means the modal has
      // silently stopped being modal.
      if (event.key !== 'Tab' || panelRef.current === null) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const previouslyFocused = document.activeElement as HTMLElement | null;
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      // Return focus where it came from, so dismissing does not dump the user
      // at the top of the document.
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Scrim strong enough to actually isolate the dialog from a dark page. */}
      <div className="absolute inset-0 bg-bg/85 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'lm-enter lm-lift relative flex max-h-[88vh] w-full flex-col rounded-panel border border-line bg-surface shadow-2xl outline-none',
          wide ? 'max-w-4xl' : 'max-w-xl',
        )}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
          <h2 id={titleId} className="font-mono text-sm font-medium text-fg">
            {title}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="size-4" aria-hidden />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">{children}</div>
        {footer !== undefined ? (
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-soft px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

/* ── Data display ────────────────────────────────────────────────────────── */

export function Stat({
  label,
  value,
  tone,
  loading = false,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: 'accent' | 'warn' | 'danger';
  /** Renders a skeleton instead of a placeholder dash. */
  loading?: boolean;
  title?: string;
}): ReactNode {
  const colour =
    tone === 'accent' ? 'text-accent' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-fg';

  return (
    <div className="min-w-0" {...(title !== undefined ? { title } : {})}>
      {/*
        The caption is `muted`, not `faint`. At 10px uppercase it is the
        smallest text in the app, which makes it the last place that can afford
        the dimmest tier — the old pairing sat at 4.2:1 and failed AA on exactly
        the labels people squint at.
      */}
      <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted">{label}</div>
      {loading ? (
        <div className="lm-skeleton mt-1 h-4 w-2/3" />
      ) : (
        // A value of "—" means "not known", and it is dimmed so it does not
        // read as data. Without this, a panel of em-dashes looks like a corpus
        // full of zeroes rather than a request that has not answered yet.
        <div className={cn('mt-0.5 truncate font-mono text-sm tnum', value === '—' ? 'text-faint' : colour)}>
          {value}
        </div>
      )}
    </div>
  );
}

/**
 * A horizontally scrollable table shell.
 *
 * A data table that overflows its container is the most common responsive
 * failure in an admin UI. Wrapping every table in its own scroll region keeps
 * the page layout intact instead of pushing the whole app sideways. `tabIndex`
 * makes the region keyboard-scrollable, which browsers do not do for free.
 */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div tabIndex={0} className={cn('min-w-0 overflow-x-auto', className)}>
      {children}
    </div>
  );
}

export function ErrorNote({
  code,
  message,
  remedy,
}: {
  code: string;
  message: string;
  remedy?: string;
}): ReactNode {
  return (
    // role="alert" so a failure that appears after an action is announced.
    <div role="alert" className="lm-enter rounded-control border border-danger/40 bg-danger/8 p-3">
      <Badge tone="danger">{code}</Badge>
      <p className="mt-2 text-sm text-fg lm-wrap-any">{message}</p>
      {remedy !== undefined && remedy.length > 0 ? (
        <p className="mt-1.5 text-xs leading-relaxed text-warn">{remedy}</p>
      ) : null}
    </div>
  );
}

/** A relevance score rendered as a value plus a proportional bar. */
export function ScoreBar({ score, className }: { score: number; className?: string }): ReactNode {
  const pct = Math.round(Math.min(1, Math.max(0, score)) * 100);
  const tone = score >= 0.6 ? 'bg-accent' : score >= 0.4 ? 'bg-info' : 'bg-faint';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="font-mono text-[11px] tnum text-fg">{score.toFixed(3)}</span>
      {/* Decorative: the number beside it already conveys the value, so the bar
          must not be the only carrier of meaning. */}
      <span className="h-1 w-8 overflow-hidden bg-inset" aria-hidden>
        <span className={cn('block h-full', tone)} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
