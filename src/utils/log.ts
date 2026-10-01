/**
 * All plugin output goes through Zotero.debug with a fixed prefix, so it
 * can be filtered in Help > Debug Output Logging.
 */
export function log(message: string, error?: unknown) {
  const detail =
    error instanceof Error ? `: ${error.message}` : error ? `: ${error}` : "";
  Zotero.debug(`[Pinakes] ${message}${detail}`);
}
