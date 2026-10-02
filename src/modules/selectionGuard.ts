/**
 * Zotero selects a newly saved item when it appears in the items list being
 * viewed, as "Add Item by Identifier" does, and Zotero.Translate.Search
 * offers no way to prevent it (it ignores saveOptions.skipSelect). In the
 * library view that would switch the item pane away from the reference
 * list after every import.
 *
 * The guard records when imports run, recognises the selection changes they
 * cause, and selects the citing item again afterwards.
 */

/** Selection changes this soon after an import are attributed to it. */
const GRACE_MS = 3000;
/** Items added this recently count as "just imported". */
const RECENT_MS = 60_000;

function isJustAdded(item: Zotero.Item) {
  const added = Zotero.Date.sqlToDate(item.dateAdded, true) as Date | false;
  return !!added && Date.now() - added.getTime() < RECENT_MS;
}

export class ImportSelectionGuard {
  private running = 0;
  private lastEnd = 0;

  /** Run an import, or a whole batch of them, under the guard. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.lastEnd = Date.now();
    }
  }

  /** Was `item` selected by Zotero because we just imported it? */
  isImportSelection(item: Zotero.Item) {
    const recent = this.running > 0 || Date.now() - this.lastEnd < GRACE_MS;
    return recent && isJustAdded(item);
  }

  /** Select `citing` again if an import moved the selection away from it. */
  restore(citing: Zotero.Item) {
    if (this.running) return;
    const pane = Zotero.getMainWindow()?.ZoteroPane;
    const selected = pane?.getSelectedItems() ?? [];
    if (
      selected.length === 1 &&
      selected[0].id !== citing.id &&
      isJustAdded(selected[0])
    ) {
      void pane!.selectItem(citing.id);
    }
  }
}
