import { Readable, Writable } from "node:stream";
import { StreamPrompt } from "../src/setup/prompt";

/** A StreamPrompt that reads these answers, one per line, and records what it showed. */
export function scripted(...answers: string[]): { prompt: StreamPrompt; shown: () => string } {
  let shown = "";
  const output = new Writable({ write(chunk, _encoding, done) { shown += String(chunk); done(); } });
  const prompt = new StreamPrompt(Readable.from(answers.map((a) => `${a}\n`)), output);
  return { prompt, shown: () => shown };
}
