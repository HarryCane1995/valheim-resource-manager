import type { ProxyOptions } from 'vite';

export function createDevProxy(target?: string): Record<string, ProxyOptions>;
