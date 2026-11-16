import assert from 'node:assert/strict';
import {test} from 'node:test';
import {embedCode, sourceName} from './embed-code.ts';

test('names what an embed runs by its repository and folder', () => {
    assert.equal(sourceName({gh: 'solidjs/templates@main:solid-v2/bare'}), 'solidjs/templates/solid-v2/bare');
    assert.equal(sourceName({gh: 'maplibre/maplibre-gl-js@pull/8628'}), 'maplibre/maplibre-gl-js');
    assert.equal(sourceName({files: {'index.html': ''}}), 'a demo');
});

test('makes an iframe that embeds a link, and starts on a click when asked', () => {
    const link = 'https://livebranch.dev/#view=result&gh=a/b@main&code=xyz';
    const code = embedCode(link, 'a/b "x" on livebranch', true);
    assert.match(code, /^<iframe src="https:\/\/livebranch\.dev\/#embed=1&amp;run=click&amp;view=result&amp;gh=a\/b@main&amp;code=xyz" /);
    assert.match(code, / title="a\/b &quot;x&quot; on livebranch" loading="lazy" /);
    assert.match(embedCode(link, 'a/b', false), /#embed=1&amp;view=result/);
});
