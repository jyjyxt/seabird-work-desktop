import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSaveSuggestions } from '../src/saveSuggestions.ts';

const block = item => `介绍\n\`\`\`seabird-save\n${JSON.stringify([item])}\n\`\`\``;

test('preserves original, image and video links in a material suggestion', () => {
  const item = { kind: 'material', title: '素材', body: '内容', source: '官方', url: 'https://example.com/', image_url: 'https://example.com/picture.png', video_url: 'https://example.com/video.mp4' };
  const parsed = parseSaveSuggestions(block(item));
  assert.equal(parsed.text, '介绍');
  assert.equal(parsed.suggestions[0].url, item.url);
  assert.equal(parsed.suggestions[0].image_url, item.image_url);
  assert.equal(parsed.suggestions[0].video_url, item.video_url);
});

test('accepts older suggestions and rejects malformed link fields', () => {
  const old = { kind: 'material', title: '素材', body: '内容' };
  const parsed = parseSaveSuggestions(block(old));
  assert.equal(parsed.suggestions[0].image_url, '');
  assert.equal(parsed.suggestions[0].video_url, '');
  const invalid = block({ ...old, image_url: 123 });
  assert.deepEqual(parseSaveSuggestions(invalid), { text: invalid, suggestions: [] });
});
