import test from 'node:test';
import assert from 'node:assert/strict';
import { articleHtml, articleMediaLink } from '../src/articleFormat.ts';

test('inserts and renders direct image and video URLs safely', () => {
  const image = articleMediaLink('image', 'https://example.com/image.png?a=1&b=2');
  const video = articleMediaLink('video', 'https://example.com/video.mp4?a=1&b=2');
  assert.equal(articleHtml('', image), '<p><img src="https://example.com/image.png?a=1&amp;b=2" alt=""></p>\n');
  assert.match(articleHtml('', video), /<video controls src="https:\/\/example\.com\/video\.mp4\?a=1&amp;b=2"><\/video>/);
  const quoted = articleMediaLink('video', 'https://example.com/video.mp4?x="onerror=alert(1)"');
  assert.match(articleHtml('', quoted), /%22onerror=alert\(1\)%22/);
});

test('rejects invalid or non-web media links', () => {
  for (const url of ['', 'example.com/a.png', 'javascript:alert(1)', 'file:///tmp/a.png', 'https://example.com/\nimage.png']) {
    assert.equal(articleMediaLink('image', url), null);
    assert.equal(articleMediaLink('video', url), null);
  }
});
