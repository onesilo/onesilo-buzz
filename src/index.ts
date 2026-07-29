/**
 * Entrypoint: connect the memory agent to a real Buzz workspace relay.
 *
 * This is the low-level way in, kept for `npm start` and for anyone running
 * from a checkout. `silo-buzz run` is the guided path — it can install and
 * set up a onesilo-node first, and prints the agent's npub and join
 * instructions once it is live. Both start the same agent via `boot.ts`.
 *
 * First run: `npm run connect` to pair with the One Silo control plane (OAuth,
 * one-time human approval). Then `npm start`. For a zero-infrastructure
 * walkthrough, run `npm run demo` instead.
 */

import { loadConfig } from "./config.js";
import { startAgent, NotPairedError } from "./boot.js";

const log = (line: string) => console.log(`[silo-memory] ${line}`);

startAgent({ config: loadConfig(), log }).catch((err) => {
  // Not-paired is an expected first-run state with a one-line fix, not a
  // crash: print the instruction without a stack trace burying it.
  if (err instanceof NotPairedError) {
    console.error("Not paired with One Silo yet. Run: npm run connect");
    process.exit(1);
  }
  console.error("failed to start agent:", err);
  process.exit(1);
});
