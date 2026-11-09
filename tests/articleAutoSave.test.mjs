import test from 'node:test';
import assert from 'node:assert/strict';
import { canAutoSaveArticle, isSavedArticle, mergeExternalCover, mergeSavedArticle, startArticleAutoSave } from '../src/articleAutoSave.ts';

const article = { id: 1, title: 'Title', body: 'Original', tags: 'tag', versions: { b: { title: 'B', body: 'b' }, a: { title: 'A', body: 'a' } }, material_ids: [2, 1], cover: null, updated_at: 'before' };

test('recognizes saved content despite database normalization and detects a later change', () => {
  const submitted = { ...article, title: ' Title ' };
  const saved = { ...article, versions: { a: article.versions.a, b: article.versions.b }, material_ids: [1, 2], updated_at: 'after' };
  assert.equal(isSavedArticle(submitted, saved, true), true);
  assert.equal(isSavedArticle(submitted, { ...saved, body: 'External edit' }, true), false);
  assert.equal(isSavedArticle(submitted, { ...saved, cover: { path: '/image.png', name: 'image.png', kind: 'image' } }, true), false);
});

test('keeps edits made during saving while updating the saved timestamp', () => {
  const saved = { ...article, updated_at: 'after' };
  const edited = { ...article, body: 'Typed while saving', tags: 'new tag' };
  assert.deepEqual(mergeSavedArticle(edited, article, saved), { ...edited, updated_at: 'after' });
  assert.deepEqual(mergeSavedArticle(article, article, saved), saved);
});


test('saves only existing, valid, changed articles when not blocked', () => {
  const snapshot = JSON.stringify(article);
  assert.equal(canAutoSaveArticle({ ...article, id: 0 }, snapshot, false), false);
  assert.equal(canAutoSaveArticle(article, snapshot, false), false);
  assert.equal(canAutoSaveArticle({ ...article, body: 'edit' }, snapshot, true), false);
  assert.equal(canAutoSaveArticle({ ...article, title: ' ' }, snapshot, false), false);
  assert.equal(canAutoSaveArticle({ ...article, body: 'edit' }, snapshot, false), true);
});

test('checks for changes every 15 seconds and stops when disposed', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const stop = startArticleAutoSave(() => { calls++; });
  t.mock.timers.tick(14_999);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  t.mock.timers.tick(15_000);
  assert.equal(calls, 2);
  stop();
  t.mock.timers.tick(15_000);
  assert.equal(calls, 2);
});

test('merges an externally saved cover without losing local edits or overwriting conflicts', () => {
  const cover = { path: '/image.jpg', name: 'image.jpg', kind: 'image' };
  const latest = { ...article, cover, updated_at: 'after' };
  const current = { ...article, body: 'Unsaved changes' };
  assert.deepEqual(mergeExternalCover(current, article, latest), { ...current, cover, updated_at: 'after' });
  assert.equal(mergeExternalCover({ ...current, cover }, article, latest), null);
  assert.equal(mergeExternalCover(current, article, { ...latest, title: 'External change' }), null);
});
