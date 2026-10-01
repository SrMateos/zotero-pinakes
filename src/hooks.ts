import { config } from "../package.json";
import { log } from "./utils/log";
import { invalidateLibraryIndex } from "./modules/library";
import {
  refreshLibraryMarks,
  registerSection,
  unregisterSection,
} from "./modules/section";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const STYLESHEET_ID = `${config.addonRef}-stylesheet`;
const MAIN_FTL = `${config.addonRef}-mainWindow.ftl`;

let notifierID: string | undefined;
let marksTimer: ReturnType<typeof setTimeout> | undefined;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  log(`Starting ${config.addonName} ${addon.data.env}`);

  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/pinakes.svg`,
  });

  registerSection();

  // Items added, edited or trashed anywhere change what is "in library".
  notifierID = Zotero.Notifier.registerObserver(
    {
      notify: async (event: string) => {
        if (!["add", "modify", "delete", "trash", "refresh"].includes(event)) {
          return;
        }
        invalidateLibraryIndex();
        if (marksTimer) clearTimeout(marksTimer);
        marksTimer = setTimeout(() => void refreshLibraryMarks(), 1000);
      },
    },
    ["item"],
    config.addonRef,
  );

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(MAIN_FTL);
  const doc = win.document;
  if (!doc.getElementById(STYLESHEET_ID)) {
    const link = doc.createElementNS(HTML_NS, "link") as HTMLLinkElement;
    link.id = STYLESHEET_ID;
    link.rel = "stylesheet";
    link.href = `chrome://${config.addonRef}/content/pinakes.css`;
    doc.documentElement?.appendChild(link);
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  win.document.getElementById(STYLESHEET_ID)?.remove();
  win.document.querySelector(`[href="${MAIN_FTL}"]`)?.remove();
}

function onShutdown(): void {
  log("Shutting down");
  if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  if (marksTimer) clearTimeout(marksTimer);
  unregisterSection();
  for (const win of Zotero.getMainWindows()) void onMainWindowUnload(win);
  addon.data.alive = false;
  delete (Zotero as unknown as Record<string, unknown>)[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};
