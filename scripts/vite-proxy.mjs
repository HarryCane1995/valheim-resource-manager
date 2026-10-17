const DEFAULT_TARGET = 'http://127.0.0.1:37841';

function isLoopbackHostWithPort(host) {
  if (typeof host !== 'string') return false;
  const match = /^(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(host);
  return !!match && Number(match[1]) <= 65535;
}

/**
 * Trust only requests whose Origin exactly matches the loopback dev-server Host.
 * Other Origins are preserved so the backend's Origin check still rejects them.
 * @param {string} [target]
 * @returns {Record<string, import('vite').ProxyOptions>}
 */
export function createDevProxy(target = DEFAULT_TARGET) {
  const backend = new URL(target);
  if (backend.protocol !== 'http:') throw new Error('Development backend must use HTTP.');
  const rewriteOrigin = (proxyReq, req) => {
    const host = req.headers.host;
    if (isLoopbackHostWithPort(host) && req.headers.origin === `http://${host}`) {
      proxyReq.setHeader('Origin', backend.origin);
    }
  };
  const configure = proxy => {
    proxy.on('proxyReq', rewriteOrigin);
    proxy.on('proxyReqWs', rewriteOrigin);
  };
  return {
    '/api': { target: backend.origin, changeOrigin: true, configure },
    '/ws': { target: backend.origin.replace(/^http:/, 'ws:'), changeOrigin: true, ws: true, configure },
  };
}
