import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';
import solid from 'vite-plugin-solid';

// The app is served from any directory: the service worker's scope is the directory of the page.
export default defineConfig({
    base: './',
    plugins: [solid(), tailwindcss()],
    worker: {format: 'es'},
    build: {target: 'es2022'},
});
