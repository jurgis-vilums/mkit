import readline from 'node:readline';

export async function askSecret(question) {
  if (process.env.MKIT_PASSPHRASE) return process.env.MKIT_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error('no TTY for passphrase prompt; set MKIT_PASSPHRASE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
