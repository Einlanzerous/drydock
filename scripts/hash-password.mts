// Turn a password into a DRYDOCK_AUTH_PASSWORD_HASH (DRY-27).
//
//   node --import tsx scripts/hash-password.mts        # prompts, twice, no echo
//   printf 'secret\n' | node --import tsx scripts/hash-password.mts
//
// Why this exists at all: DRYDOCK_AUTH_PASSWORD works and is the low-ceremony
// way in, but it puts a password in plaintext wherever the env comes from — a
// gitignored `.env` is fine, a systemd unit file or a compose file is less so,
// and shell history is worse than either. The hash is safe in all of them.
//
// It takes no ARGUMENT on purpose, in either mode: a password on the command
// line is in `ps` for every user on the host, and in the shell history
// afterwards.
import * as readline from "node:readline";
import { hashPassword } from "../daemon/src/auth/password.js";

const MIN = 8;

/**
 * Two code paths, because readline has one behaviour on a terminal and another
 * on a pipe — and the difference is a HANG, not an error.
 *
 * With piped stdin every line arrives at once and the stream then ends, so the
 * interface closes as soon as the first answer is read: a second `rl.question`
 * is never called back, the promise never settles, and Node exits 13 with
 * "unsettled top-level await". Nothing about the interactive run reveals it, so
 * the script that works when you write it hangs the first time somebody puts it
 * in a pipeline. Piped input therefore reads the stream directly and skips the
 * confirmation — there is nothing to confirm against, and a typo in a pipeline
 * is the caller's to catch.
 */
async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split("\n")[0];
}

async function prompt(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  const stdout = process.stdout;
  const realWrite = stdout.write.bind(stdout);
  // Suppress the echo of what is TYPED, not the prompt — hence a flag flipped
  // around the answer rather than a blanket mute.
  (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) =>
    muted ? true : realWrite(chunk);
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => {
        muted = false;
        realWrite("\n");
        resolve(answer);
      });
      muted = true;
    });
  try {
    const first = await ask("Password: ");
    if ((await ask("Again: ")) !== first) {
      process.stderr.write("drydock: they don't match.\n");
      process.exit(1);
    }
    return first;
  } finally {
    (stdout as unknown as { write: unknown }).write = realWrite;
    rl.close();
  }
}

const password = process.stdin.isTTY ? await prompt() : await readPiped();
if (password.length < MIN) {
  process.stderr.write(`drydock: that is under ${MIN} characters — the daemon would refuse it.\n`);
  process.exit(1);
}
process.stdout.write(`\nDRYDOCK_AUTH_PASSWORD_HASH=${await hashPassword(password)}\n`);
