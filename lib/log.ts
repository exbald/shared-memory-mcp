export type Logger = (event: Record<string, unknown>) => void;

/** One JSON line per event on stdout, where Coolify and `docker logs` pick it up. */
export const log: Logger = (event) => {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
};
