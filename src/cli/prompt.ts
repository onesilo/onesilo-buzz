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

/**
 * Ask a free-text question. Enter (or no terminal) takes the default; the
 * non-interactive path says so, same contract as askYesNo.
 */
export async function askText(
  question: string,
  opts: { default: string; io?: AskOptions["io"] }
): Promise<string> {
  const io = opts.io ?? {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
  };

  if (!io.isTTY) {
    io.output.write(`${question} [${opts.default}] ${opts.default}  (no terminal — using the default)\n`);
    return opts.default;
  }

  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const raw = (await rl.question(`${question} [${opts.default}] `)).trim();
    return raw || opts.default;
  } finally {
    rl.close();
  }
}

export interface Choice<T extends string> {
  value: T;
  /** Short label, e.g. "Local". */
  label: string;
  /** What it does, in terms of consequence rather than configuration. */
  lines: string[];
}

export interface AskChoiceOptions<T extends string> {
  default: T;
  /** Forces the answer without asking (--yes, or an env var already set). */
  forced?: T;
  io?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTTY: boolean };
}

/**
 * Ask a multiple-choice question, printing each option with its tradeoffs.
 *
 * Deliberately not a yes/no about a dependency. Where a workspace's
 * conversation ends up is the most consequential decision in this setup and
 * the least visible one, so it is asked directly, with what each answer
 * costs written next to it — rather than inferred from "shall I install
 * this program?".
 */
export async function askChoice<T extends string>(
  question: string,
  choices: Choice<T>[],
  opts: AskChoiceOptions<T>
): Promise<T> {
  if (opts.forced) return opts.forced;

  const io = opts.io ?? {
    input: process.stdin,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
  };

  const numbered = choices.map((c, i) => ({ ...c, key: String(i + 1) }));
  const defaultKey = numbered.find((c) => c.value === opts.default)?.key ?? "1";

  if (!io.isTTY) {
    io.output.write(
      `${question} — using ${opts.default} (no terminal)\n`
    );
    return opts.default;
  }

  io.output.write(`\n${question}\n\n`);
  for (const choice of numbered) {
    const marker = choice.value === opts.default ? " (default)" : "";
    io.output.write(`  ${choice.key}. ${choice.label}${marker}\n`);
    for (const line of choice.lines) io.output.write(`     ${line}\n`);
    io.output.write("\n");
  }

  const rl = createInterface({ input: io.input, output: io.output });
  try {
    for (;;) {
      const raw = (await rl.question(`Choose 1-${numbered.length} [${defaultKey}]: `))
        .trim()
        .toLowerCase();
      if (raw === "") return opts.default;
      const byKey = numbered.find((c) => c.key === raw);
      if (byKey) return byKey.value;
      // Accept the name too — someone who read the docs will type "hybrid".
      const byName = numbered.find((c) => c.value === raw);
      if (byName) return byName.value;
      io.output.write(`Please answer 1-${numbered.length}, or the mode name.\n`);
    }
  } finally {
    rl.close();
  }
}
