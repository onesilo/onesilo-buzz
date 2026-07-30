/**
 * Terminal prompts that behave when there is no terminal.
 *
 * `onesilo-buzz run` gets used in CI, under supervisors, and piped into logs
 * just as often as it is typed. A prompt that blocks forever in those cases
 * turns a scripted install into a hung job with no output explaining why, so
 * every question here has a defined non-interactive answer and says which
 * one it took.
 */

import { createInterface } from "node:readline/promises";

export type Answer = "yes" | "no";

export interface AskOptions {
  /** Used when stdin is not a TTY, and when the user just presses enter. */
  default: Answer;
  /**
   * Forces the answer without asking. `--yes` / `--no-node` map here, so a
   * scripted run is explicit rather than relying on the non-interactive
   * default happening to be right.
   */
  forced?: Answer;
  /** Injected in tests; defaults to the real stdin/stdout. */
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean };
}

/**
 * Ask a yes/no question.
 *
 * Returns the forced answer if one was given, the default if stdin is not a
 * TTY, and otherwise whatever was typed. An unrecognised reply re-asks
 * rather than guessing — this gates installing software, which is not a
 * thing to do on an ambiguous answer.
 */
export async function askYesNo(question: string, opts: AskOptions): Promise<Answer> {
  if (opts.forced) return opts.forced;

  const io = opts.io ?? {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
  };

  if (!io.isTTY) {
    io.output.write(
      `${question} ${suffix(opts.default)} ${opts.default}  (no terminal — using the default)\n`
    );
    return opts.default;
  }

  const rl = createInterface({ input: io.input, output: io.output });
  try {
    for (;;) {
      const raw = (await rl.question(`${question} ${suffix(opts.default)} `)).trim().toLowerCase();
      if (raw === "") return opts.default;
      if (raw === "y" || raw === "yes") return "yes";
      if (raw === "n" || raw === "no") return "no";
      io.output.write("Please answer y or n.\n");
    }
  } finally {
    rl.close();
  }
}

/** `[Y/n]` or `[y/N]`, with the default capitalised — the usual convention. */
function suffix(def: Answer): string {
  return def === "yes" ? "[Y/n]" : "[y/N]";
}
