/**
 * Async coordination helpers for the chunked comparison loop. Runs in the SW.
 * Callers: comparison-modes.js (compareChunked), comparator.js (matching loop).
 */
import { get } from '../../config/defaults.js';

const YIELD_CHUNK_SIZE = get('comparison.matching.yieldChunkSize', 64);

/**
 * A MessageChannel port pair used as a zero-delay yield mechanism.
 * setTimeout(0) is throttled to ~1 s in an idle SW; MessageChannel.postMessage
 * fires as a near-immediate macrotask (~0 ms) so the event loop stays responsive
 * without stalling the comparison. port1.start() is required to activate the port
 * before any messages can be received.
 */
const yieldChannel = new MessageChannel();
yieldChannel.port1.start();

/** Yields control to the SW event loop for one macrotask turn without an artificial delay. */
function yieldToEventLoop() {
  return new Promise(resolve => {
    yieldChannel.port1.addEventListener('message', resolve, { once: true });
    yieldChannel.port2.postMessage(null);
  });
}

/** Constructs a progress frame yielded by the comparison generator to report incremental progress. */
function progressFrame(label, pct) {
  return { type: 'progress', label, pct };
}

/** Constructs the final result frame yielded by the comparison generator. */
function resultFrame(payload) {
  return { type: 'result', payload };
}

export { yieldToEventLoop, YIELD_CHUNK_SIZE, progressFrame, resultFrame };