// `node:url`. A path maps to the URL that the project file is served at, so that it can be imported.
import {state, toPath} from './state.js';

export function fileURLToPath(url) {
    return toPath(url);
}

export function pathToFileURL(path) {
    return new URL(state.root + encodeURI(toPath(path)));
}

const {URL, URLSearchParams} = globalThis;
export {URL, URLSearchParams};
export default {fileURLToPath, pathToFileURL, URL, URLSearchParams};
