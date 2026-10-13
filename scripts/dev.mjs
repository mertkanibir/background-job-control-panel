import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'server/index.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  Promise.all(
    children.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once('exit', resolve)),
    ),
  ).then(() => process.exit(code));
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
