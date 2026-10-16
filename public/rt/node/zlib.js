// `node:zlib`, its synchronous calls. pako does the work, and the results are Buffers, as Node's are.
import {Buffer} from './buffer.js';
import {deflate, deflateRaw, gzip, inflate, inflateRaw, ungzip} from 'https://esm.sh/pako@3.0.2';

const bytes = data => typeof data === 'string' ? new TextEncoder().encode(data) : data;
const sync = run => (data, options) => Buffer.from(run(bytes(data), options));

export const gzipSync = sync(gzip);
export const gunzipSync = sync(ungzip);
export const deflateSync = sync(deflate);
export const inflateSync = sync(inflate);
export const deflateRawSync = sync(deflateRaw);
export const inflateRawSync = sync(inflateRaw);
/** Inflates gzip or zlib data, by its first byte, as Node's unzip does. */
export const unzipSync = (data, options) => bytes(data)[0] === 0x1f ? gunzipSync(data, options) : inflateSync(data, options);

export default {gzipSync, gunzipSync, deflateSync, inflateSync, deflateRawSync, inflateRawSync, unzipSync};
