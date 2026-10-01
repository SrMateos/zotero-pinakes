import Addon from "./addon";
import { config } from "../package.json";

// Expose the plugin instance as Zotero.Pinakes (bootstrap.js calls its hooks).
const Z = Zotero as unknown as Record<string, unknown>;
if (!Z[config.addonInstance]) {
  const addon = new Addon();
  _globalThis.addon = addon;
  Z[config.addonInstance] = addon;
}
