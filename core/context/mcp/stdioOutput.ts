import { scrubForDisk } from "../../util/secretScan";
import { secretValuesFromEnv } from "../../util/secretScan/envValues";
import { knownValueMatcher } from "../../util/secretScan/knownValues";

/**
 * What a stdio MCP server wrote to stderr, kept for the connect-failure
 * message. A server can log without limit for as long as it runs, so only the
 * first and the last `HEAD_MAX` and `TAIL_MAX` characters are held. The head
 * usually has the startup banner or the first error and the tail has the last
 * thing it said before it died.
 */
export const STDIO_OUTPUT_HEAD_MAX = 4 * 1024;
export const STDIO_OUTPUT_TAIL_MAX = 4 * 1024;

export class StdioOutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  append(chunk: string): void {
    let rest = chunk;
    if (this.head.length < STDIO_OUTPUT_HEAD_MAX && this.tail === "") {
      const room = STDIO_OUTPUT_HEAD_MAX - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    if (this.tail.length > STDIO_OUTPUT_TAIL_MAX) {
      const over = this.tail.length - STDIO_OUTPUT_TAIL_MAX;
      this.dropped += over;
      this.tail = this.tail.slice(over);
    }
  }

  get isEmpty(): boolean {
    return this.head === "" && this.tail === "";
  }

  /**
   * The captured text with secrets masked. `env` is the environment the server
   * was started with: a server that echoes its own `API_KEY` is masked even
   * when the value has no recognisable shape. Where text was dropped, the cut
   * ends are trimmed back to whitespace first, so a credential cut in half by
   * the cap leaves no readable fragment.
   */
  render(env: Readonly<Record<string, string | undefined>> = {}): string {
    const known = knownValueMatcher(secretValuesFromEnv(env));
    const mask = (s: string) => scrubForDisk(s, "at-rest", { known });
    if (this.dropped === 0 && this.tail.length <= STDIO_OUTPUT_TAIL_MAX) {
      // Nothing was dropped: scrub the text whole so a secret that straddles
      // the head/tail seam is still seen.
      return mask(this.head + this.tail);
    }
    const head = this.head.replace(/\S*$/, "");
    const tail = this.tail.replace(/^\S*/, "");
    return `${mask(head)}\n[... ${this.dropped} characters omitted ...]\n${mask(tail)}`;
  }
}
