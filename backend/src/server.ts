import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { buildApp } from './app.ts';

const port = Number(process.env.PORT ?? 4000);
const dataDir = process.env.DATA_DIR ?? path.resolve(import.meta.dirname, '..', 'data');

const { app } = buildApp({ dataDir, log: true });

await app.listen({ port, host: '0.0.0.0' });

const lan = Object.values(networkInterfaces())
  .flat()
  .find(address => address && address.family === 'IPv4' && !address.internal)?.address;

console.log(`Field Reports backend listening on :${port}`);
console.log(`  local     http://localhost:${port}`);
if (lan) console.log(`  device    http://${lan}:${port}   (or: adb reverse tcp:${port} tcp:${port})`);
console.log(`  data      ${dataDir}`);
console.log(`  faults    npm run fault -- <preset>   (npm run fault -- list)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
