/**
 * Small formatting helpers shared by everything that writes progress lines.
 *
 * These live outside agent.ts so the silo stores can use them without
 * importing the agent — a store depending on the agent would invert the
 * layering for the sake of two string functions.
 */

/**
 * Elapsed time, log-friendly. Sub-second work reads better in ms; anything
 * a human would notice reads better in seconds.
 */
export function since(startMs: number, nowMs: number = Date.now()): string {
  const ms = Math.max(0, nowMs - startMs);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One-line clip of message text for log previews. Collapses whitespace so a
 * pasted stack trace or a multi-line message can't take over the console.
 */
export function preview(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
