import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);

export function loadPty() {
  if (process.env.MCP_NODE_PTY_PATH) return require(process.env.MCP_NODE_PTY_PATH);
  try { return require('node-pty'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Reuse the already installed ccsm test dependency on the developer machine.
    return require(join(process.env.APPDATA, 'npm/node_modules/@bakapiano/ccsm/node_modules/node-pty'));
  }
}
