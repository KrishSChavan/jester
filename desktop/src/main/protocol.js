/**
 * `jester://` — where every page the app shows is served from.
 *
 * The extension's own pages (the engine, calibration) run here unchanged, so
 * they need what Chrome gives an extension page: a stable origin of their own,
 * relative imports that resolve, `fetch()` for the MediaPipe models and WASM,
 * and the same content security policy. Two hosts:
 *
 *   jester://ext/…  the extension folder, read-only, exactly as it ships
 *   jester://app/…  the desktop app's own pages (overlay, settings)
 */

import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolveFile } from './files.js';

/**
 * The extension's manifest policy, plus `connect-src 'self'` with nothing else:
 * the engine page has no reason to reach the network, and this makes that a
 * rule rather than a habit. MediaPipe's usage pings die here too, on top of
 * boot.js refusing them.
 */
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'; connect-src 'self'";

/** Must run before the app is ready. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'jester', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }
  ]);
}

export function serveFiles() {
  protocol.handle('jester', async (request) => {
    const file = resolveFile(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return response;
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}
