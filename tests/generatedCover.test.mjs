import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedCoverPath, hideGeneratedCoverBlock, saveGeneratedCover } from '../src/generatedCover.ts';

const cover = { path: '/work/seabird-media/image.png', name: 'image.png', kind: 'image' };
const article = { id: 1, title: '标题', body: '正文', tags: '', versions: {}, material_ids: [], cover: null, updated_at: 'now' };
const target = { root: '/work', id: 1, original: null, canApply: () => true };

test('reads and hides the generated image path', () => {
  const output = '完成\n```seabird-cover\n{"path":"/tmp/image.png"}\n```';
  assert.equal(generatedCoverPath(output), '/tmp/image.png');
  assert.equal(hideGeneratedCoverBlock(output), '完成');
  assert.equal(generatedCoverPath('```seabird-cover\n{"path":"relative.png"}\n```'), null);
  assert.equal(generatedCoverPath('```seabird-cover\nnot json\n```'), null);
});

test('imports the generated file and saves the cover with the latest article as expected', async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'content_import_media') return cover;
    if (command === 'content_load') return { articles: [article] };
    if (command === 'content_save_article') return { backup_warning: 'backup failed' };
    throw new Error(command);
  };
  assert.equal(await saveGeneratedCover(target, '/tmp/image.png', invoke), 'backup failed');
  assert.deepEqual(calls.map(call => call[0]), ['content_import_media', 'content_load', 'content_save_article']);
  assert.deepEqual(calls[2][1], { root: '/work', item: { ...article, cover }, expected: article });
});

test('does not replace a cover changed locally or in the database', async () => {
  let saved = false;
  const invoke = async command => {
    if (command === 'content_import_media') return cover;
    if (command === 'content_load') return { articles: [{ ...article, cover }] };
    saved = true;
  };
  await assert.rejects(saveGeneratedCover(target, '/tmp/image.png', invoke), /封面已被修改/);
  await assert.rejects(saveGeneratedCover({ ...target, canApply: () => false }, '/tmp/image.png', invoke), /封面已被修改/);
  assert.equal(saved, false);
});

test('reports invalid files and save conflicts without claiming success', async () => {
  await assert.rejects(saveGeneratedCover(target, '/tmp/video.mp4', async () => ({ ...cover, kind: 'video' })), /不是图片/);
  await assert.rejects(saveGeneratedCover(target, '/tmp/image.png', async command => {
    if (command === 'content_import_media') return cover;
    if (command === 'content_load') return { articles: [article] };
    throw new Error('文章已被修改');
  }), /文章已被修改/);
});
