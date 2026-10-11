import type {ProjectConfig} from './spec.ts';

const MAPLIBRE_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MapLibre GL JS</title>
<link rel="stylesheet" href="./dist/maplibre-gl.css">
<style>html, body, #map { margin: 0; height: 100%; }</style>
</head>
<body>
<div id="map"></div>
<!--entry-->
</body>
</html>
`;

const MAPLIBRE_DEMO = `import * as maplibregl from 'maplibre-gl';

const map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [10, 50],
    zoom: 3,
    hash: true,
});
map.addControl(new maplibregl.NavigationControl());
`;

const MAPLIBRE_BUNDLE = 'export * from \'../src/index.ts\';\n';

/**
 * Configs for projects that cannot carry a `livebranch.json` of their own. The key is the `name` of the
 * project's package.json.
 */
export const presets: Record<string, ProjectConfig> = {
    // The library is compiled from `src`. Its generated sources are not in git, so the generators
    // run first. The files of `dist` stand in for the bundles, so that the example pages of the
    // repository (test/examples) run as they are. In a release the worker is a file next to the
    // bundle. Here it is a module next to the source that looks for it.
    'maplibre-gl': {
        setup: [
            'node build/generate-shaders.ts',
            'node build/generate-struct-arrays.ts',
            'node build/generate-style-code.ts',
        ],
        prebuilt: [
            // The Unicode generator downloads from unicode.org, which sends no CORS headers.
            {files: ['src/util/unicode_properties.g.ts'], inputs: ['build/generate-unicode-data.ts']},
            // The stylesheet is made by PostCSS.
            {files: ['dist/maplibre-gl.css'], inputs: ['src/css/maplibre-gl.css']},
        ],
        alias: {'maplibre-gl': './src/index.ts'},
        entries: ['src/util/maplibre-gl-worker.mjs'],
        files: {
            'src/util/maplibre-gl-worker.mjs': 'import \'../source/worker.ts\';\n',
            'dist/maplibre-gl.mjs': MAPLIBRE_BUNDLE,
            'dist/maplibre-gl-dev.mjs': MAPLIBRE_BUNDLE,
            'demo.ts': MAPLIBRE_DEMO,
        },
        // A demo is a script. Its page has the stylesheet and a full-size `#map` to put the map in.
        entry: 'demo.ts',
        template: MAPLIBRE_TEMPLATE,
    },
};
