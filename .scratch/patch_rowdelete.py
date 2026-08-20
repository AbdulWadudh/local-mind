import io

# ── 1. recorder gains remove() ────────────────────────────────────────────
p = 'src/core/recorder.ts'
s = io.open(p, encoding='utf-8').read()

old = """  stats(): ModelCallStats;
  /** Returns how many records were dropped. */
  clear(): number;
  readonly enabled: boolean;
}"""
new = """  stats(): ModelCallStats;
  /** Drop one record. Returns false if it was already gone. */
  remove(id: string): boolean;
  /** Returns how many records were dropped. */
  clear(): number;
  readonly enabled: boolean;
}"""
assert old in s
s = s.replace(old, new, 1)

old = """    clear: () => 0,
    enabled: false,
  };"""
new = """    remove: () => false,
    clear: () => 0,
    enabled: false,
  };"""
assert old in s
s = s.replace(old, new, 1)

old = """    clear() {
      const dropped = buffer.length;
      buffer.length = 0;
      bufferBytes = 0;
      evicted = 0;
      return dropped;
    },"""
new = """    remove(id) {
      const index = buffer.findIndex((record) => record.id === id);
      if (index === -1) return false;
      const [dropped] = buffer.splice(index, 1);
      // Keep the byte counter in step. Letting it drift would slowly starve the
      // buffer: the byte bound would evict records that are no longer there.
      if (dropped !== undefined) bufferBytes -= approximateBytes(dropped);
      return true;
    },

    clear() {
      const dropped = buffer.length;
      buffer.length = 0;
      bufferBytes = 0;
      evicted = 0;
      return dropped;
    },"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('recorder.remove added')

# ── 2. router ─────────────────────────────────────────────────────────────
p = 'src/studio/router.ts'
s = io.open(p, encoding='utf-8').read()

old = """  api.delete('/calls', async (context) => {
    const mind = await getMind();
    return context.json({ cleared: mind.recorder.clear() });
  });"""
new = """  api.delete('/calls', async (context) => {
    const mind = await getMind();
    return context.json({ cleared: mind.recorder.clear() });
  });

  api.delete('/calls/:id', async (context) => {
    const mind = await getMind();
    const removed = mind.recorder.remove(context.req.param('id'));
    // 200 either way: the buffer is a ring, so a record the user deletes may
    // already have been evicted. That is the requested end state, not an error.
    return context.json({ removed });
  });"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('router delete-one added')

# ── 3. api client ─────────────────────────────────────────────────────────
p = 'studio/src/lib/api.ts'
s = io.open(p, encoding='utf-8').read()
old = "    clear: (): Promise<{ cleared: number }> => json('/calls', { method: 'DELETE' }),"
new = """    remove: (id: string): Promise<{ removed: boolean }> =>
      json(`/calls/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    clear: (): Promise<{ cleared: number }> => json('/calls', { method: 'DELETE' }),"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('api client updated')

# ── 4. the row control ────────────────────────────────────────────────────
p = 'studio/src/views/InspectView.tsx'
s = io.open(p, encoding='utf-8').read()

old = """  const clear = useCallback(async () => {
    await api.calls.clear();
    setSelectedId(null);
    await load();
  }, [load]);"""
new = """  const clear = useCallback(async () => {
    await api.calls.clear();
    setSelectedId(null);
    await load();
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      await api.calls.remove(id);
      // Clear the selection only if it was the deleted row, so removing noise
      // from the list does not close the call you were reading.
      setSelectedId((previous) => (previous === id ? null : previous));
      await load();
    },
    [load],
  );"""
assert old in s
s = s.replace(old, new, 1)

# The row becomes a <div> wrapper holding the select button and the delete
# button, because a <button> cannot legally contain another <button>.
old = """                return (
                  <li key={call.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(selected ? null : call.id)}
                      aria-current={selected ? 'true' : undefined}
                      className={cn(
                        'w-full cursor-pointer px-3.5 py-2.5 text-left transition-colors duration-200',
                        selected ? 'bg-accent/10' : 'hover:bg-inset/50',
                      )}
                    >
                      <div className="flex items-center gap-2">"""
new = """                return (
                  <li
                    key={call.id}
                    className={cn(
                      'group relative transition-colors duration-200',
                      selected ? 'bg-accent/10' : 'hover:bg-inset/50',
                    )}
                  >
                    {/* A <button> may not contain another <button>, so the row
                        selector and the delete control are siblings, with the
                        delete absolutely positioned over the row's top-right. */}
                    <button
                      type="button"
                      onClick={() => setSelectedId(selected ? null : call.id)}
                      aria-current={selected ? 'true' : undefined}
                      className="w-full cursor-pointer px-3.5 py-2.5 pr-10 text-left"
                    >
                      <div className="flex items-center gap-2">"""
assert old in s
s = s.replace(old, new, 1)

old = """                        {call.settings.responseFormat === 'json' ? <span>json</span> : null}
                      </div>
                    </button>
                  </li>
                );"""
new = """                        {call.settings.responseFormat === 'json' ? <span>json</span> : null}
                      </div>
                    </button>

                    {/*
                      Stays in the DOM and only changes opacity, so it is
                      keyboard-reachable — a hover-only affordance is unreachable
                      without a pointer. No confirmation: this discards one line
                      of a session-scoped debug log, which is not a destructive
                      act worth a dialog.
                    */}
                    <div className="absolute right-2 top-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void remove(call.id)}
                        aria-label={`Delete this ${call.stage} call from the log`}
                        title="Delete this entry"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </li>
                );"""
assert old in s
s = s.replace(old, new, 1)

# The bulk button gets a clearer label now that a single-row delete exists.
old = """          <Button
            variant="danger"
            size="sm"
            onClick={() => void clear()}
            disabled={(stats?.total ?? 0) === 0}
            title="Empty the buffer. Nothing is written to disk, so this is not undoable."
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>"""
new = """          <Button
            variant="danger"
            size="sm"
            onClick={() => void clear()}
            disabled={(stats?.total ?? 0) === 0}
            title="Empty the whole buffer. Nothing is written to disk, so this is not undoable."
          >
            <Trash2 className="size-3.5" aria-hidden />
            Clear all
          </Button>"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('row delete added')
