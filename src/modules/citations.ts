/**
 * Pure helpers for numeric in-text citation markers such as "[23]" or
 * "[4, 7–9]". No Zotero globals here, so this is unit-tested in Node.
 */

export interface Marker {
  /** Offsets of the whole marker, brackets included, in the searched text. */
  start: number;
  end: number;
  /** Cited numbers, ranges expanded ("7–9" gives 7, 8, 9). */
  numbers: number[];
}

const NUMBER_OR_RANGE = String.raw`\d{1,4}(?:\s*[-–—]\s*\d{1,4})?`;
const MARKER = new RegExp(
  String.raw`\[\s*(${NUMBER_OR_RANGE}(?:\s*[,;]\s*${NUMBER_OR_RANGE})*)\s*\]`,
  "g",
);
/** Ranges longer than this are not expanded (probably not a citation). */
const MAX_RANGE = 50;

function expand(list: string): number[] | undefined {
  const numbers: number[] = [];
  for (const part of list.split(/[,;]/)) {
    const [a, b] = part.split(/[-–—]/).map((x) => Number(x.trim()));
    if (b === undefined) {
      numbers.push(a);
    } else {
      if (b < a || b - a > MAX_RANGE) return undefined;
      for (let n = a; n <= b; n++) numbers.push(n);
    }
  }
  // "[0]" or "[2019]" are not citations.
  if (numbers.some((n) => n < 1 || n > 999)) return undefined;
  return [...new Set(numbers)];
}

/** All numeric citation markers in `text`. */
export function findMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const numbers = expand(m[1]);
    if (numbers) {
      markers.push({ start: m.index!, end: m.index! + m[0].length, numbers });
    }
  }
  return markers;
}

/** The marker containing the character at `offset`, if any. */
export function markerAt(text: string, offset: number): Marker | undefined {
  return findMarkers(text).find((m) => offset >= m.start && offset < m.end);
}
