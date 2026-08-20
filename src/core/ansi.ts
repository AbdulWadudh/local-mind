/**
 * Terminal styling built from `String.fromCharCode(27)` rather than literal
 * escape bytes, so this file stays copy-paste safe through any pipeline.
 * Colour is disabled automatically when stdout is not a TTY or NO_COLOR is set.
 */

const ESC = String.fromCharCode(27);

const ENABLED =
  process.env['NO_COLOR'] === undefined &&
  process.env['LOCALMIND_LOG'] !== 'json' &&
  Boolean(process.stderr.isTTY ?? true);

function sgr(code: number): string {
  return ENABLED ? `${ESC}[${code}m` : '';
}

const RESET = sgr(0);

function wrap(code: number): (text: string) => string {
  const open = sgr(code);
  return (text: string): string => (ENABLED ? `${open}${text}${RESET}` : text);
}

export const style = {
  reset: RESET,
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  grey: wrap(90),
} as const;

/** Raw opening codes, for callers that need to build their own spans. */
export const raw = {
  reset: RESET,
  dim: sgr(2),
  grey: sgr(90),
  cyan: sgr(36),
  yellow: sgr(33),
  red: sgr(31),
} as const;
