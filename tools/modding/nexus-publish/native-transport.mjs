// Prime Node's own lazy Undici before @actions/core imports its bundled older dispatcher.
// data: fetch is local only: no DNS, sockets, credentials or provider discovery.
const symbol = Symbol.for('undici.globalDispatcher.1');

export async function primeNativeDispatcher(nativeFetch = globalThis.fetch) {
  const version = process.versions.undici?.split('.').map(Number);
  if (process.versions.node.split('.')[0] !== '24' || !version || version[0] !== 7
    || version[1] < 18 || (version[1] === 18 && version[2] < 2) || globalThis[symbol]) {
    throw new Error('Reviewed fresh Node 24 native transport required.');
  }
  const response = await nativeFetch('data:text/plain,nexus-native-transport-prime');
  if (!response.ok || await response.text() !== 'nexus-native-transport-prime') {
    throw new Error('Native transport initialization refused.');
  }
  const dispatcher = globalThis[symbol];
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') {
    throw new Error('Native transport initialization refused.');
  }
  // Lock the selected identity against bundle initialization or a later replacement.
  Object.defineProperty(globalThis, symbol, { value: dispatcher, writable: false, configurable: false });
  return dispatcher;
}
