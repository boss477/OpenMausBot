// End-to-end coverage for the send_voice_note slice (#1742): the tool a real
// agents proxy advertises, the harness route that synthesizes and parks the
// clip, the attachment that lands on the settling reply, and the cancel path
// that must leave no orphan audio behind. The TTS provider is a loopback
// Chatterbox stub so no external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

const MP3 = Buffer.from("ID3 fake mp3 for the voice note fixture");

async function withVoiceFixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  let ttsServer: Server | undefined;
  const seen: Array<{ input: string; voice: string }> = [];
  const dataDir = session.info.dataDir;
  const planPath = join(dataDir, "room-plan.json");
  try {
    await test({
      session,
      cli,
      api,
      seen,
      dataDir,
      attachmentsDir: () => join(dataDir, "attachments"),
      mp3Files: () => {
        const dir = join(dataDir, "attachments");
        return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".mp3")) : [];
      },
      savePlan: (plan: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(plan)),
      evidence: () => existsSync(planPath + ".evidence.jsonl")
        ? readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
      messages: async (threadId: string) => (await api("/api/threads/" + threadId + "/messages")).messages,
      serveTts: async () => {
        const server = createServer((req, res) => {
          let raw = "";
          req.on("data", (chunk: Buffer) => { raw += chunk; });
          req.on("end", () => {
            if (!(req.url ?? "").includes("/audio/speech")) {
              res.writeHead(404);
              res.end();
              return;
            }
            const body = JSON.parse(raw);
            seen.push({ input: String(body.input ?? ""), voice: String(body.voice ?? "") });
            res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(MP3.byteLength) });
            res.end(MP3);
          });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        ttsServer = server;
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no stub port");
        return "http://127.0.0.1:" + address.port;
      },
    });
  } finally {
    ttsServer?.close();
    await session.close();
  }
}

it("advertises send_voice_note to a ready bot and attaches the clip to the settling reply", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Voice note bot")).bot;
  const note = "Quick voice note: the export finished and every check passed.";
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "  " + note + "  " } }],
      reply: "The summary you can also listen to.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send the status as a voice note.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  expect(turn).toBeTruthy();
  const listed = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listed).toContain("send_voice_note");
  const step = turn.evidence.find((entry: any) => entry.step);
  expect(step.response.result.isError).toBeFalsy();
  expect(step.response.result.content[0].text).toContain("Voice note recorded");

  // The note is synthesized verbatim (outer trim only) with the configured voice.
  expect(f.seen).toEqual([{ input: note, voice: "voice-a" }]);

  const messages = await f.messages(bot.activeTaskId);
  const withAudio = messages.filter((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"));
  expect(withAudio).toHaveLength(1);
  expect(withAudio[0].role).toBe("bot");
  expect(withAudio[0].text).toBe("The summary you can also listen to.");
  const audio = withAudio[0].attachments.find((a: any) => a.kind === "audio");
  expect(audio.mime).toBe("audio/mpeg");

  const files = f.mp3Files();
  expect(files).toHaveLength(1);
  expect(audio.path.endsWith(files[0])).toBe(true);
  const stored = join(f.attachmentsDir(), files[0]);
  // Windows cannot represent a POSIX owner-only mode; writeFileAtomic's 0600
  // is enforced where it exists, like every other attachment-mode assertion.
  if (process.platform !== "win32") expect(statSync(stored).mode & 0o777).toBe(0o600);
  expect(readFileSync(stored).equals(MP3)).toBe(true);
}), 60_000);

it("makes the note text the visible transcript when the turn writes no reply", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Voice only bot")).bot;
  const note = "Voice only: nothing else to read here.";
  f.savePlan({ [bot.id]: { steps: [{ tool: "send_voice_note", arguments: { text: note } }], reply: "" } });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Answer with the voice note alone.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const messages = await f.messages(bot.activeTaskId);
  const withAudio = messages.filter((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"));
  expect(withAudio).toHaveLength(1);
  expect(withAudio[0].text).toBe(note);
  expect(f.mp3Files()).toHaveLength(1);
}), 60_000);

it("hides the tool and refuses the call when no voice is configured", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Silent bot")).bot;
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "Should not synthesize." }, expectError: true }],
      reply: "Done without a note.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Try a voice note.");
  expect((await f.cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");

  const turn = f.evidence().find((entry: any) => entry.botId === bot.id);
  const listed = turn.evidence[0].result.tools.map((tool: any) => tool.name);
  expect(listed).not.toContain("send_voice_note");
  const step = turn.evidence.find((entry: any) => entry.step);
  // Refused as an unmounted tool (or a tool error), never a failed turn.
  expect(Boolean(step.response.error || step.response.result?.isError)).toBe(true);
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.some((m: any) => m.text === "Done without a note.")).toBe(true);
  expect(messages.some((m: any) => (m.attachments ?? []).some((a: any) => a.kind === "audio"))).toBe(false);
  expect(f.seen).toEqual([]);
  expect(f.mp3Files()).toEqual([]);
}), 60_000);

it("deletes a parked voice note when the turn is cancelled mid-flight", async () => withVoiceFixture(async (f) => {
  const baseUrl = await f.serveTts();
  await f.api("/api/config", { tts: { provider: "chatterbox", baseUrl, voice: "voice-a" } }, "PUT");
  const bot = (await f.cli("new-bot", "--name", "Cancelled note bot")).bot;
  const gate = join(f.dataDir, "voice-note-gate");
  f.savePlan({
    [bot.id]: {
      steps: [{ tool: "send_voice_note", arguments: { text: "This note will be cancelled." } }],
      gateFile: gate,
      reply: "Never reached.",
    },
  });
  await f.cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Send a note, then hold.");
  // The clip is synthesized and parked while the fixture turn waits on its gate.
  await expect.poll(() => f.mp3Files().length, { timeout: 20_000 }).toBe(1);
  await f.api("/api/bots/" + bot.id + "/interrupt", { threadId: bot.activeTaskId });
  await expect.poll(() => f.mp3Files(), { timeout: 20_000 }).toEqual([]);
}), 90_000);

