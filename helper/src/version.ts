import plugin from "../../.claude-plugin/plugin.json" with { type: "json" };

/**
 * The helper's version, which is always the plugin's version. `bun build` bundles the JSON, so the number is
 * fixed in the binary when it is built; the session-start hook compares it with the installed plugin's.
 */
export const VERSION: string = plugin.version;
