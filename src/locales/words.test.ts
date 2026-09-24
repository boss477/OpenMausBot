import { expect, it } from "vitest";

import en from "./en.json";

// The product words: the tenant is an "Organization" (US spelling, as in
// Admin), and one running OpenMausBot is an "installation". A remote one saved
// in the desktop is a "server" and a bot's or task's directory is a "folder".
// "Workspace" survives only as Slack's own term, or another product's term.
const ALLOWED = new Set([
  "engines.account.apiKey", // the Anthropic Console's "workspace API key"
  "engineSetup.device.enableHint", // a ChatGPT "workspace admin"
  // Keys another branch adds with its own wording go here until reviewed.
]);

it("English copy says Organization and installation, not Organisation or workspace", () => {
  const offending = Object.entries(en)
    .filter(([key, value]) => !ALLOWED.has(key) && (/organis/i.test(value) || /(?<!Slack )\bworkspaces?\b/i.test(value)))
    .map(([key]) => key);
  expect(offending).toEqual([]);
});
