// Grok speech-to-text (POST https://api.x.ai/v1/stt). Reuses the workspace
// xAI key exactly like Grok TTS does, so a user who already has Grok voice
// gets recognition with no new credential.
import type { SttProvider, TranscribeOptions, Transcript, Utterance } from "./types.ts";

const API = (process.env.OMB_XAI_STT_API || "https://api.x.ai/v1").replace(/\/+$/, "");

function refusal(status: number): string {
  if (status === 401 || status === 403) return "xAI rejected the key or its speech permissions. Check the xAI key in Settings.";
  if (status === 402) return "The xAI account needs credits to transcribe speech.";
  if (status === 429) return "xAI is rate-limiting speech recognition. Wait a moment and try again.";
  return `Grok speech recognition failed (HTTP ${status}).`;
}

export function xaiStt(key: string, timeoutMs = 20_000): SttProvider {
  return {
    id: "xai",
    async transcribe(utterance: Utterance, call: TranscribeOptions): Promise<Transcript> {
      const form = new FormData();
      // xAI reads option fields before the file; the file must come last.
      form.append("format", "true");
      if (call.language) form.append("language", call.language.slice(0, 2).toLowerCase());
      form.append("file", new Blob([utterance.wav.slice()], { type: "audio/wav" }), "utterance.wav");

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(`${API}/stt`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: form,
          signal,
          redirect: "error",
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error("Grok speech recognition timed out.");
        }
        throw new Error("Could not reach Grok speech recognition. Check your connection.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(refusal(response.status));
      }
      const body = (await response.json().catch(() => null)) as { text?: unknown; language?: unknown } | null;
      if (!body || typeof body.text !== "string") throw new Error("Grok returned an unreadable transcript.");
      return { text: body.text.trim(), language: typeof body.language === "string" ? body.language : undefined };
    },
  };
}
