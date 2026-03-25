import { get } from '../../config/defaults.js';

const YIELD_CHUNK_SIZE = get('comparison.matching.yieldChunkSize', 64);

const yieldChannel = new MessageChannel();
yieldChannel.port1.start();

function yieldToEventLoop() {
  return new Promise(resolve => {
    yieldChannel.port1.addEventListener('message', resolve, { once: true });
    yieldChannel.port2.postMessage(null);
  });
}

function progressFrame(label, pct) {
  return { type: 'progress', label, pct };
}

function resultFrame(payload) {
  return { type: 'result', payload };
}

export { yieldToEventLoop, YIELD_CHUNK_SIZE, progressFrame, resultFrame };