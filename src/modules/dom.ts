/**
 * Small DOM and formatting helpers shared by the item pane section and the
 * reader's citation popups.
 */
import type { Reference } from "./types";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Create an HTML element (also inside XUL documents). */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A button whose clicks do not reach the surrounding row. */
export function button(
  doc: Document,
  label: string,
  onClick: () => void,
  className = "pinakes-button",
) {
  const el = h(doc, "button", className, label);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

/** A button that copies `text` and says "Copied" for a moment. */
export function copyButton(doc: Document, label: string, text: string) {
  const el = button(doc, label, () => {
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    el.textContent = "Copied";
    setTimeout(() => (el.textContent = label), 1500);
  });
  return el;
}

/** "Surname et al., 2019", or undefined when there are no authors. */
export function authorYear(ref: Reference) {
  const surname = ref.authors[0]?.trim().split(/\s+/).pop();
  const who = surname
    ? ref.authors.length > 1
      ? `${surname} et al.`
      : surname
    : undefined;
  return [who, ref.year].filter(Boolean).join(", ") || undefined;
}

/** The page opened by "Open": the DOI, else the arXiv abstract page. */
export function referenceUrl(ref: Reference) {
  if (ref.doi) return `https://doi.org/${ref.doi}`;
  if (ref.arxiv) return `https://arxiv.org/abs/${ref.arxiv}`;
  return undefined;
}
