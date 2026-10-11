// `node:fs/promises`.
import {promises} from './fs.js';

export const {access, appendFile, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile} = promises;
export default promises;
