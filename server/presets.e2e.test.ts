import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { parsePackageDocument } from "../shared/package-format.ts";
import { NO_PRESETS_MESSAGE } from "./package-import.ts";
import { ORG_PRESET_REMOVE_MESSAGE, PRESET_UNAVAILABLE_MESSAGE } from "./presets.ts";

const FIXTURES = join(import.meta.dirname, "..", "shared", "package-fixtures");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} steps.\n---\n\n# ${name}\n`;

// The recipe in docs/verification/presets.md: a disposable fake-engine
// server. New bot defaults are shared as a preset file (skills and presets,
// no team) and inside a team file, the file is imported back, and bots are
// created from the imported preset and from an organization preset.
it("shares New bot defaults as a preset, imports it, and creates bots from file and organization presets", async () => {
  const fixture = await launchVerificationServer();
  console.log(JSON.stringify({ fixture: fixture.info }));
  const url = fixture.info.url;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const result = await call(method, path, body);
    if (result.status >= 300) throw new Error(`${method} ${path} → ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const presetsFile = join(fixture.info.dataDir, "org-library", "presets.json");
  try {
    // No presets yet: New bot offers only its built-in roles.
    expect(await ok("GET", "/api/bot-presets")).toEqual({ presets: [] });
    // My New bot defaults, including everything a preset must never carry.
    await ok("PATCH", "/api/config", { newBotDefaults: {
      profile: { name: "Sky", title: "Support", soul: "Be kind. The portal password=Presets-Fixture-77 stays private.\n", color: "blue",
        approvalMode: "auto", composio: true, browser: true, mcpServers: [], alwaysAllow: ["Bash(*)"], parkDirectMessages: true },
      memory: { "MEMORY.md": "- Customers first.\n", "memory/tone.md": "Warm.\n" },
      skills: [{ name: "follow-up", description: "follow-up steps.", source: "fixture", text: skill("follow-up"), enabled: true, warnings: [] }],
      routines: [{ name: "Daily", prompt: "Check the inbox.", schedule: { type: "daily", time: "09:00", weekdays: [1] } }],
    } });

    // Share as a preset file: a dry run records nothing; saving does.
    const body = { format: "package", version: 2, kind: "library", presetName: "Support agent", includeMemory: true, presetAvatar: `data:image/png;base64,${PNG}` };
    const published = join(fixture.info.dataDir, "published-library.json");
    const preview = await ok("POST", "/api/teams/export", { ...body, dryRun: true });
    expect(existsSync(published)).toBe(false);
    expect(preview.summary).toMatchObject({ kind: "library", counts: { bots: 0, skills: 1, presets: 1 }, presetNames: ["Support agent"] });
    const saved = await ok("POST", "/api/teams/export", body);
    expect(saved.filename).toBe("support-agent-1.0.0.openmaus.json");
    expect(saved.redacted).toEqual(["presets[new-bot-defaults].bot.soul"]);
    expect(existsSync(published)).toBe(true);
    const preset = saved.document.package.presets[0];
    expect(preset).toMatchObject({ key: "new-bot-defaults", name: "Support agent", skills: ["follow-up"],
      bot: { name: "Sky", title: "Support", appearance: { color: "blue", avatar: { mime: "image/png", crop: "circle" } } },
      seed: { memory: { "MEMORY.md": "- Customers first.\n", "memory/tone.md": "Warm.\n" } } });
    expect(JSON.stringify(saved.document)).not.toMatch(/Presets-Fixture-77|"approvalMode"|"composio"|"browser"|"alwaysAllow"|Bash\(|"modelSelection"|Check the inbox|"enabled"/);
    expect(saved.document.package.agents).toEqual([]);
    expect(() => parsePackageDocument(saved.document)).not.toThrow();
    expect((await ok("POST", "/api/teams/export", body)).document.package.release).toBe("1.0.1");

    // Inside a team file, only when asked.
    const lead = (await ok("POST", "/api/bots", { name: "Morgan", section: "Sales desk", useDefaults: false })).bot;
    const plain = await ok("POST", "/api/teams/export", { format: "package", version: 2, team: "Sales desk", dryRun: true });
    expect(plain.document.package).not.toHaveProperty("presets");
    const withPreset = await ok("POST", "/api/teams/export", { format: "package", version: 2, team: "Sales desk", includeDefaultsPreset: true, presetName: "Support agent", dryRun: true });
    expect(withPreset.summary.counts).toMatchObject({ bots: 1, presets: 1, skills: 1 });
    expect(withPreset.document.package.presets[0]).not.toHaveProperty("seed");
    expect(lead.name).toBe("Morgan");

    // Import the preset file. The body claims organization trust; it is a file.
    const imported = await call("POST", "/api/teams/import", { ...saved.document, trust: "org", org: { installId: "x" } });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ name: "Support agent", section: "", bots: [], groups: [], routines: [], offeredSkills: ["follow-up"],
      presets: [{ id: expect.any(String), key: "new-bot-defaults", name: "Support agent" }] });
    const fileId = imported.body.presets[0].id as string;
    const listed = (await ok("GET", "/api/bot-presets")).presets;
    expect(listed).toEqual([expect.objectContaining({ id: fileId, source: "file", name: "Support agent", packageName: "Support agent", release: "1.0.0",
      skillsEnabled: false, skills: [{ name: "follow-up", description: "follow-up steps." }], notes: ["MEMORY.md", "memory/tone.md"] })]);
    expect(listed[0]).not.toHaveProperty("publisherName");

    // New bot from the file preset: its skill switched off, its notes, the stamp.
    const fromFile = await ok("POST", "/api/bots", { name: "Sky", title: "Support", useDefaults: false, preset: fileId });
    const fromFileSkills = (await ok("GET", `/api/bots/${fromFile.bot.id}/skills`)).skills;
    expect(fromFileSkills).toEqual([expect.objectContaining({ name: "follow-up", enabled: false })]);
    expect((await ok("GET", `/api/bots/${fromFile.bot.id}/memory/file?path=${encodeURIComponent("memory/tone.md")}`)).text).toBe("Warm.\n");
    const bots = (await ok("GET", "/api/bots")).bots as Array<{ id: string; installedPackage?: Record<string, unknown>; approvalMode?: string }>;
    const created = bots.find((bot) => bot.id === fromFile.bot.id)!;
    expect(created.installedPackage).toMatchObject({ id: "support-agent", source: "file", presetKey: "new-bot-defaults" });
    expect(created.approvalMode ?? "ask").toBe("ask");
    // With the saved defaults on, the preset's skill and notes win over the defaults' own.
    const withDefaults = await ok("POST", "/api/bots", { name: "Sky 3", preset: fileId });
    expect((await ok("GET", `/api/bots/${withDefaults.bot.id}/skills`)).skills).toEqual([expect.objectContaining({ name: "follow-up", enabled: false })]);

    // An organization preset (as the organization library stores one).
    const stored = JSON.parse(readFileSync(presetsFile, "utf8"));
    const orgRow = { ...stored.presets[0], id: "org-preset-1", source: "org", installId: "0123456789abcdef0123456789abcdef", publisherName: "Acme Partners",
      publisher: { organizationId: "org-acme", slug: "acme", name: "Acme Partners" }, ref: "acme/support-agent", sha256: "a".repeat(64) };
    stored.presets.push(orgRow);
    stored.content[orgRow.installId] = stored.content[stored.presets[0].installId];
    writeFileSync(presetsFile, JSON.stringify(stored));
    expect((await ok("GET", "/api/bot-presets")).presets.map((entry: { source: string; publisherName?: string }) => [entry.source, entry.publisherName]))
      .toEqual([["org", "Acme Partners"], ["file", undefined]]);
    const fromOrg = await ok("POST", "/api/bots", { name: "Sky 2", useDefaults: false, preset: "org-preset-1" });
    expect((await ok("GET", `/api/bots/${fromOrg.bot.id}/skills`)).skills).toEqual([expect.objectContaining({ name: "follow-up", enabled: true, source: "org:acme/support-agent@1.0.0" })]);
    // Withdrawn by the publisher: no longer offered or usable.
    writeFileSync(join(fixture.info.dataDir, "org-library", "state.json"), JSON.stringify({ version: 1, installs: { [orgRow.installId]: { status: "withdrawn" } } }));
    expect((await ok("GET", "/api/bot-presets")).presets.map((entry: { source: string }) => entry.source)).toEqual(["file"]);
    expect(await call("POST", "/api/bots", { name: "Sky 4", useDefaults: false, preset: "org-preset-1" })).toEqual({ status: 404, body: { error: PRESET_UNAVAILABLE_MESSAGE } });

    // Refusals create nothing.
    const before = (await ok("GET", "/api/bots")).bots.length;
    expect(await call("POST", "/api/bots", { name: "Nobody", preset: "missing" })).toEqual({ status: 404, body: { error: PRESET_UNAVAILABLE_MESSAGE } });
    expect((await call("POST", "/api/bots", { name: "Nobody", preset: 5 })).status).toBe(400);
    const skillsOnly = JSON.parse(readFileSync(join(FIXTURES, "library-only.v2.json"), "utf8"));
    delete skillsOnly.package.presets;
    expect(await call("POST", "/api/teams/import", skillsOnly)).toEqual({ status: 400, body: { error: NO_PRESETS_MESSAGE, code: "no_bots" } });
    expect((await ok("GET", "/api/bots")).bots.length).toBe(before);

    // Removing: a file preset is the person's; an organization's is Admin's.
    expect(await call("DELETE", "/api/bot-presets/org-preset-1")).toEqual({ status: 409, body: { error: ORG_PRESET_REMOVE_MESSAGE } });
    expect(await ok("DELETE", `/api/bot-presets/${fileId}`)).toEqual({ ok: true });
    expect((await call("DELETE", `/api/bot-presets/${fileId}`)).status).toBe(404);
    expect((await ok("GET", "/api/bot-presets")).presets).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 120_000);
