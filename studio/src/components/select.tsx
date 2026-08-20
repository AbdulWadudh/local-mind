import type { ComponentProps, ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';

import { cn } from '../lib/cn';

/**
 * Select — the shadcn/ui composition, restyled onto LocalMind's tokens.
 *
 * WHY A DEPENDENCY HERE, WHEN `ui.tsx` DELIBERATELY HAS NONE
 *
 * `ui.tsx` avoids component libraries because those primitives are thin styling
 * over native elements, where the platform already gives us the behaviour and a
 * dependency would only add weight. A listbox is the opposite case. Doing it
 * properly means typeahead, roving focus, arrow/Home/End/PageUp navigation,
 * `aria-activedescendant`, collision-aware positioning, scroll locking, focus
 * return on close and pointer-vs-keyboard distinction. That is a real
 * implementation, and hand-rolling it produces a dropdown that looks right and
 * fails for keyboard users.
 *
 * The cost lands only on the Studio's own prebuilt bundle. The client is
 * compiled to static assets under `dist/studio/client` and shipped as files, so
 * `radix-ui` never appears in a consumer's dependency graph or module bundle —
 * it stays a devDependency for exactly that reason.
 *
 * DEVIATIONS FROM UPSTREAM
 *
 *  - Tokens instead of shadcn's `--input` / `--popover` / `--accent` names, so
 *    this matches the rest of the app rather than importing a second palette.
 *  - No `tw-animate-css`. Upstream leans on `animate-in` / `zoom-in-95`, which
 *    is another dependency for classes this design system already has an opinion
 *    about — one duration, one easing, subtle tier.
 *  - `position="popper"` by default. `item-aligned` overlays the trigger, which
 *    in a dense toolbar hides the control you just clicked.
 */

function Select(props: ComponentProps<typeof SelectPrimitive.Root>): ReactNode {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>): ReactNode {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>): ReactNode {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...rest
}: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: 'sm' | 'default' }): ReactNode {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        'flex w-fit cursor-pointer items-center justify-between gap-2 border border-line-soft',
        'bg-inset px-2.5 text-sm text-fg whitespace-nowrap outline-none',
        'transition-colors duration-200 ease-out-soft hover:border-line',
        // 32px minimum at `default` — the floor below which a pointer target
        // starts costing accuracy, and comfortably past the 24px WCAG 2.2 AA
        // minimum for web targets.
        'data-[size=default]:h-8 data-[size=sm]:h-7',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-[placeholder]:text-muted',
        'focus-visible:border-accent',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        '*:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:text-left',
        className,
      )}
      {...rest}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-3.5 text-muted" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...rest
}: ComponentProps<typeof SelectPrimitive.Content>): ReactNode {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        // `lm-lift` gives the popover the same top-edge hairline as every other
        // raised surface, so it reads as part of the system.
        className={cn(
          'lm-lift relative z-50 max-h-(--radix-select-content-available-height) min-w-[10rem]',
          'overflow-x-hidden overflow-y-auto border border-line bg-surface',
          'shadow-[0_12px_32px_-8px_oklch(0_0_0/0.55)]',
          'data-[state=open]:lm-enter',
          position === 'popper' ? 'data-[side=bottom]:mt-1 data-[side=top]:-mt-1' : '',
          className,
        )}
        position={position}
        sideOffset={4}
        {...rest}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn('p-1', position === 'popper' ? 'w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1' : '')}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...rest }: ComponentProps<typeof SelectPrimitive.Label>): ReactNode {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted', className)}
      {...rest}
    />
  );
}

function SelectItem({ className, children, ...rest }: ComponentProps<typeof SelectPrimitive.Item>): ReactNode {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center gap-2 py-1.5 pl-2 pr-8 text-sm',
        'text-fg outline-hidden transition-colors duration-200 ease-out-soft',
        // Highlight is `raised` + accent text: two carriers, so the focused row
        // is not signalled by colour alone.
        'data-[highlighted]:bg-raised data-[highlighted]:text-accent',
        'data-[state=checked]:text-accent',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-45',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...rest}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span data-slot="select-item-indicator" className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-accent" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...rest }: ComponentProps<typeof SelectPrimitive.Separator>): ReactNode {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-line-soft', className)}
      {...rest}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...rest
}: ComponentProps<typeof SelectPrimitive.ScrollUpButton>): ReactNode {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1 text-muted', className)}
      {...rest}
    >
      <ChevronUp className="size-3.5" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...rest
}: ComponentProps<typeof SelectPrimitive.ScrollDownButton>): ReactNode {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1 text-muted', className)}
      {...rest}
    >
      <ChevronDown className="size-3.5" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
