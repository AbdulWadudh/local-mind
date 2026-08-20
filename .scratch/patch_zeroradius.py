import io

# ── 1. tokens ─────────────────────────────────────────────────────────────
p = 'studio/src/styles.css'
s = io.open(p, encoding='utf-8').read()

old = """  /* ── Radii ───────────────────────────────────────────────────────────────
   * preset: --radius 0.875rem, with the sm/md/lg ramp derived from it exactly
   * as the preset's own `@theme inline` block does.
   */
  --radius-panel: 0.875rem;   /* 14px — preset --radius        */
  --radius-control: 0.525rem; /* 8.4px — preset --radius * 0.6 */
  --spacing-panel: 0.75rem;"""
new = """  /* ── Radii: zero, everywhere ─────────────────────────────────────────────
   * Square corners are the whole geometry of this theme, so the entire scale is
   * flattened rather than just the two tokens this app names. Tailwind's own
   * `rounded`, `rounded-sm`, `rounded-md` and so on resolve against these, so
   * overriding only `--radius-panel` and `--radius-control` would leave the 16
   * bare `rounded` utilities in the views quietly rounding at 4px — a mix of
   * sharp panels and soft badges, which looks like an oversight rather than a
   * decision.
   *
   * `--radius-full` is deliberately left alone: it means "a pill or a circle",
   * which is a shape rather than a corner treatment. The three places that used
   * it are converted to squares individually instead.
   */
  --radius-none: 0;
  --radius-xs: 0;
  --radius-sm: 0;
  --radius-md: 0;
  --radius-lg: 0;
  --radius-xl: 0;
  --radius-2xl: 0;
  --radius-3xl: 0;
  --radius-4xl: 0;
  --radius-panel: 0;
  --radius-control: 0;
  --spacing-panel: 0.75rem;"""
assert old in s
s = s.replace(old, new, 1)

# ── 2. hand-written radii in the stylesheet ───────────────────────────────
replacements = [
    # scrollbar thumb
    ("""*::-webkit-scrollbar-thumb {
  background: var(--color-inset);
  border: 2px solid transparent;
  border-radius: 6px;
  background-clip: content-box;
}""",
     """*::-webkit-scrollbar-thumb {
  background: var(--color-inset);
  border: 2px solid transparent;
  background-clip: content-box;
}"""),
    # focus ring
    (""":focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
  border-radius: 4px;
}""",
     """:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}"""),
    # streaming pulse: a square ring around a square avatar
    ("""  position: absolute;
  inset: 0;
  border-radius: 9999px;
  border: 2px solid var(--color-accent);""",
     """  position: absolute;
  inset: 0;
  border: 2px solid var(--color-accent);"""),
    # skeleton
    ("""  animation: lm-shimmer 1.6s linear infinite;
  border-radius: 0.375rem;
}""",
     """  animation: lm-shimmer 1.6s linear infinite;
}"""),
    # inline code
    ("""  padding: 0.1em 0.35em;
  border-radius: 0.3rem;
}""",
     """  padding: 0.1em 0.35em;
}"""),
    # citation chip
    ("""  padding: 0.22em 0.4em;
  margin: 0 0.12em;
  border-radius: 0.25rem;""",
     """  padding: 0.22em 0.4em;
  margin: 0 0.12em;"""),
]
for old_text, new_text in replacements:
    assert old_text in s, old_text[:60]
    s = s.replace(old_text, new_text, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('styles.css squared off')

# ── 3. the three rounded-full uses and the one arbitrary radius ───────────
p = 'studio/src/App.tsx'
s = io.open(p, encoding='utf-8').read()
old = 'after:-bottom-[7px] after:h-0.5 after:rounded-full after:bg-accent'
new = 'after:-bottom-[7px] after:h-0.5 after:bg-accent'
assert old in s
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
print('App.tsx tab rule squared')

p = 'studio/src/components/ui.tsx'
s = io.open(p, encoding='utf-8').read()
old = """      <span className="h-1 w-8 overflow-hidden rounded-full bg-inset" aria-hidden>
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${pct}%` }} />"""
new = """      <span className="h-1 w-8 overflow-hidden bg-inset" aria-hidden>
        <span className={cn('block h-full', tone)} style={{ width: `${pct}%` }} />"""
assert old in s
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
print('ScoreBar squared')

p = 'studio/src/views/ChatView.tsx'
s = io.open(p, encoding='utf-8').read()
old = "'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[0.3rem] px-2.5',"
new = "'inline-flex h-7 cursor-pointer items-center gap-1.5 px-2.5',"
assert old in s
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
print('mode segment squared')

# ── 4. the Select popover, which sets its own radius ──────────────────────
p = 'studio/src/components/select.tsx'
s = io.open(p, encoding='utf-8').read()
before = s.count('rounded')
s = s.replace("'lm-lift relative z-50 max-h-(--radix-select-content-available-height) min-w-[10rem]',\n          'overflow-x-hidden overflow-y-auto rounded-panel border border-line bg-surface',",
              "'lm-lift relative z-50 max-h-(--radix-select-content-available-height) min-w-[10rem]',\n          'overflow-x-hidden overflow-y-auto border border-line bg-surface',", 1)
s = s.replace("'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-control py-1.5 pl-2 pr-8 text-sm',",
              "'relative flex w-full cursor-pointer select-none items-center gap-2 py-1.5 pl-2 pr-8 text-sm',", 1)
s = s.replace("'flex w-fit cursor-pointer items-center justify-between gap-2 rounded-control border border-line-soft',",
              "'flex w-fit cursor-pointer items-center justify-between gap-2 border border-line-soft',", 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('select.tsx: %d -> %d rounded refs' % (before, s.count('rounded')))
