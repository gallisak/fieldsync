import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { until } from './pg';

export interface ServerProcess {
  url: string;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  alive(): boolean;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Runs `src/main.ts` in its own Node process. Inside Jest an uncaught exception is only reported; in a real
 * process it is fatal, which is what a test about crashes has to observe.
 */
export async function startServerProcess(env: Record<string, string>): Promise<ServerProcess> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ['-r', join(__dirname, 'register-ts.js'), join(__dirname, '../../src/main.ts')],
    { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const alive = () => child.exitCode === null && child.signalCode === null;

  const url = `http://127.0.0.1:${port}`;
  try {
    await until(
      async () => {
        if (!alive()) throw new Error(`server process exited during startup:\n${output}`);
        return fetch(`${url}/health`).then(
          (r) => r.ok,
          () => false,
        );
      },
      'the server process to start',
      30_000,
    );
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  return {
    url,
    output: () => output,
    alive,
    async stop() {
      if (alive()) child.kill('SIGTERM');
      await exited;
    },
  };
}
