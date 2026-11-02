/**
 * npm run fault -- list                 show presets and the active config
 * npm run fault -- <preset>             apply a preset (2g, flaky, hang, lose-commit-response, ...)
 * npm run fault -- clear                back to a healthy server
 * npm run fault -- wipe                 delete every report on the server
 * npm run fault -- stats                how many reports/images the server holds
 *
 * SERVER_URL defaults to http://localhost:4000.
 */
const server = process.env.SERVER_URL ?? 'http://localhost:4000';
const [command = 'list'] = process.argv.slice(2);

async function call(method: string, path: string): Promise<unknown> {
  const response = await fetch(`${server}${path}`, { method });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  switch (command) {
    case 'list':
      print(await call('GET', '/__faults'));
      break;
    case 'clear':
      print(await call('DELETE', '/__faults'));
      break;
    case 'wipe':
      print(await call('POST', '/__reset'));
      break;
    case 'stats':
      print(await call('GET', '/__stats'));
      break;
    default:
      print(await call('POST', `/__faults/preset/${encodeURIComponent(command)}`));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
