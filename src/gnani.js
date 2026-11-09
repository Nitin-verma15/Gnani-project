// Gnani.ai speech: Prisma for speech-to-text and Timbre for text-to-speech.
// API reference: https://docs.gnani.ai/api/introduction/introduction
const TIMEOUT_MS = 20_000;
const MAX_KEYTERMS = 200; // documented limit for prisma-v3.0

// Hinglish lists both languages as hints; transliterate keeps the output in Latin letters.
const STT_LANGUAGE = { hinglish: "hi-IN,en-IN", english: "en-IN" };
const STT_TOPIC = "A small Indian shop owner keeping accounts: sales, udhaar (credit), payments, expenses, orders, appointments, rupee amounts and customer names.";
const TTS_VOICE = {
  hinglish: { voice: "Poorvi", language: "hi-en" },
  english: { voice: "Kaveri", language: "en-IN" },
};

export const SPEECH_MODES = Object.keys(STT_LANGUAGE);

export class GnaniError extends Error {
  constructor(status, detail) {
    super(`Gnani API error ${status}: ${detail}`);
    this.status = status;
  }

  /** Short enough to show in the assistant panel. */
  get friendly() {
    if (this.status === 401 || this.status === 403) return "The Gnani API key isn't working. Check GNANI_API_KEY in .env.";
    if (this.status === 402) return "The Gnani account is out of credit.";
    if (this.status === 429) return "Gnani is busy right now. Please try again in a moment.";
    return "Voice service had a problem. Please try again, or type below.";
  }
}

export function createGnani({ apiKey, baseUrl = "https://api.vachana.ai" }) {
  async function request(path, init) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, "X-API-Key-ID": apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GnaniError(503, err.message);
    }
    if (!res.ok) throw new GnaniError(res.status, (await res.text()).slice(0, 300));
    return res;
  }

  return {
    /** Returns the transcript in Latin letters, or "" if no speech was found. */
    async transcribe({ audio, mode = "hinglish", keyterms = [] }) {
      const form = new FormData();
      form.append("audio_file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
      form.append("model", "prisma-v3.0");
      form.append("language_code", STT_LANGUAGE[mode]);
      form.append("format", "transliterate");
      form.append("topic", STT_TOPIC);
      // "<|" and "|>" are rejected by the API, and one bad name shouldn't fail the request.
      const terms = keyterms.filter((t) => t && !/<\||\|>/.test(t)).slice(0, MAX_KEYTERMS);
      if (terms.length) form.append("keyterms", JSON.stringify(terms));
      const res = await request("/stt/v3", { method: "POST", body: form });
      const body = await res.json();
      return (body.transcript ?? "").trim();
    },

    /** Returns MP3 audio. Timbre reads ₹ amounts and numbers aloud naturally by itself. */
    async synthesize({ text, mode = "hinglish" }) {
      const res = await request("/api/v1/tts/inference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model: "timbre-v2.5",
          ...TTS_VOICE[mode],
          audio_config: { sample_rate: 24000, container: "mp3", bitrate: "96k" },
        }),
      });
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
