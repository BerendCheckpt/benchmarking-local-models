// Lists the models on the Ollama server by running `ollama list` over SSH.
import { SshTarget } from "./ssh.mjs";

export { fingerprint } from "./ssh.mjs";

/** First column of `ollama list`, header row skipped. */
export function parseOllamaList(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

const ollama = new SshTarget("OLLAMA_SSH");

export async function listModels() {
  try {
    return parseOllamaList((await ollama.exec("ollama list")).toString("utf8"));
  } catch (err) {
    throw new Error(`ollama list ${err.message}`);
  }
}
