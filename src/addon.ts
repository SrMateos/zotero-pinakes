import { config } from "../package.json";
import hooks from "./hooks";
import { hoverForTest } from "./modules/citationPopups";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
  };
  public hooks: typeof hooks;
  /** Used by the integration tests; not exposed in release builds. */
  public testHooks = __env__ === "production" ? undefined : { hoverForTest };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
  }
}

export default Addon;
