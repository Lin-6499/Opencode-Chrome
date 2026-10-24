import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const hostName = 'local.opencode.chrome_control';
const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
const nativeDir = path.join(root, 'native');
const manifestPath = path.join(nativeDir, 'host.json');
const extensionDir = path.join(root, 'extension').toLowerCase();
if (process.platform !== 'win32') throw new Error('This installer currently supports Windows Chrome only.');

if (process.argv.includes('--uninstall')) {
  const previous = spawnSync('reg.exe', ['query', registryKey, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (previous.status === 0) {
    if (!previous.stdout.toLowerCase().includes(manifestPath.toLowerCase())) throw new Error('Registry entry belongs to another installation; refusing to remove it.');
    const result = spawnSync('reg.exe', ['delete', registryKey, '/f'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || 'Could not unregister native host');
  }
  console.log('Native pairing unregistered for this Windows user. Project files and tokens were preserved.');
  process.exit(0);
}

const explicit = process.argv.indexOf('--extension-id');
const ids = new Set();
if (explicit !== -1) ids.add(process.argv[explicit + 1]);
else {
  const userData = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  if (existsSync(userData)) {
    for (const profile of readdirSync(userData, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      for (const name of ['Preferences', 'Secure Preferences']) {
        const file = path.join(userData, profile.name, name);
        let data;
        try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
        // Only extension IDs and local paths are used; never output profile data.
        for (const [id, entry] of Object.entries(data.extensions?.settings || {})) {
          if (typeof entry.path === 'string' && path.resolve(entry.path).toLowerCase() === extensionDir) ids.add(id);
        }
      }
    }
  }
}
if (!ids.size) {
  console.error('Could not locate the loaded extension. Load the extension folder in Chrome first, then run this installer again.');
  console.error('Alternatively: node install-native.mjs --extension-id <ID displayed in chrome://extensions>');
  process.exit(1);
}
for (const id of ids) if (!/^[a-p]{32}$/.test(id || '')) throw new Error('Invalid extension ID');
const previous = spawnSync('reg.exe', ['query', registryKey, '/ve'], { encoding: 'utf8', windowsHide: true });
if (previous.status === 0 && !previous.stdout.toLowerCase().includes(manifestPath.toLowerCase())) throw new Error('A different installation owns this native host name; refusing to overwrite its registration.');
mkdirSync(nativeDir, { recursive: true });
// Chrome's official Windows native-messaging sample also uses a .bat launcher.
const launcher = path.join(nativeDir, 'launch.bat');
writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0..\\native-host.mjs" %*\r\n`);
writeFileSync(manifestPath, JSON.stringify({
  name: hostName,
  description: 'Chrome Control local automatic pairing',
  path: launcher,
  type: 'stdio',
  allowed_origins: [...ids].map(id => `chrome-extension://${id}/`),
}, null, 2));
const result = spawnSync('reg.exe', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw new Error(result.stderr || 'Could not register native host');
console.log(`Automatic pairing installed for ${ids.size} matching extension ID(s). No administrator access needed.`);
console.log('Reload the Chrome Control extension, then open its popup. No token entry is required.');
