import test from 'node:test';
import assert from 'node:assert/strict';
import { applyArticleEdit, findArticleForSuggestion, linkSavedArticle } from '../src/articleAgent.ts';

const draft = { id: 0, title: '', body: '', tags: '参考', versions: {}, material_ids: [3, 7], cover: null, updated_at: '' };
const target = { root: '/workspace', id: 0, editor: 'session:1', platform: 'original', title: '', body: '', draft };

test('reopens a new article after leaving its editor and preserves its references', () => {
  const original = findArticleForSuggestion(target, null, '', [], undefined);
  const edit = applyArticleEdit(target, original, { title: '新文章', body: '文章正文' });
  assert.deepEqual({ ...original, ...edit }, { ...draft, title: '新文章', body: '文章正文' });
  assert.equal(findArticleForSuggestion(target, null, '', [], undefined), draft);
});

test('uses the active or saved article and rejects stale suggestions', () => {
  const saved = { ...draft, id: 4, title: '原文', body: '已有内容' };
  const savedTarget = { ...target, id: 4, title: '原文', body: '已有内容', draft: undefined };
  const changed = { ...saved, body: '用户的新修改' };
  assert.equal(findArticleForSuggestion(savedTarget, changed, 'another', [saved], undefined), changed);
  assert.equal(applyArticleEdit(savedTarget, changed, { body: 'Agent 的修改' }), null);
  assert.equal(findArticleForSuggestion(savedTarget, null, '', [saved], undefined), saved);
  assert.equal(findArticleForSuggestion(savedTarget, null, '', [], undefined), null);
});

test('finds a draft that was saved before the user left the editor', () => {
  const saved = { ...draft, id: 8, title: '已保存', updated_at: 'now' };
  assert.equal(findArticleForSuggestion(target, null, '', [saved], saved), saved);
  assert.equal(findArticleForSuggestion(target, null, '', [], saved), null);
});

test('links a draft suggestion to its saved article for later sessions', () => {
  const linked = linkSavedArticle(target, '/workspace', 'session:1', 8);
  assert.equal(linked.id, 8);
  assert.equal(linked.draft, undefined);
  const saved = { ...draft, id: 8 };
  assert.equal(findArticleForSuggestion(linked, null, '', [saved], undefined), saved);
  assert.equal(findArticleForSuggestion(linked, null, '', [], undefined), null);
  assert.equal(linkSavedArticle(target, '/other', 'session:1', 8), target);
  assert.equal(linkSavedArticle(target, '/workspace', 'session:2', 8), target);
});

test('does not replace selected text when the selection is no longer unique', () => {
  const selectionTarget = { ...target, body: 'one target end', selection: { start: 4, end: 10, text: 'target' } };
  assert.deepEqual(applyArticleEdit(selectionTarget, { title: '', body: 'new one target end' }, { body: 'result' }), { title: '', body: 'new one result end' });
  assert.equal(applyArticleEdit(selectionTarget, { title: '', body: 'target one target end' }, { body: 'result' }), null);
});
