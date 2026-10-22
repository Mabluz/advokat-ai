import { EMBED_MODEL, OLLAMA_URL } from "./config.js";

export async function embed(texts: string[], attempt = 1): Promise<number[][]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, truncate: true }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const { embeddings } = (await res.json()) as { embeddings: number[][] };
    return embeddings;
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return embed(texts, attempt + 1);
  }
}
