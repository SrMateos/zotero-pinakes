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
  /** Only used by the integration tests. */
  public testHooks = { hoverForTest };

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
