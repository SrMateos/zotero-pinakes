// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
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
