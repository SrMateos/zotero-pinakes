// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  // Local diagnostic tests, not part of the repository (see .gitignore).
  ignores: ["test/debug/**"],
  overrides: [
    {
      // Integration tests group several suites in one file.
      files: ["test/zotero/**/*.ts"],
      rules: {
        "mocha/max-top-level-suites": "off",
      },
    },
  ],
});
