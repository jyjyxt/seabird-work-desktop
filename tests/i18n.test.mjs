import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { resolveLanguage, translateText, translateBackend } from '../src/i18nCore.ts';

const catalog = JSON.parse(readFileSync(new URL('../src/translations/en.json', import.meta.url), 'utf8'));
const backend = JSON.parse(readFileSync(new URL('../src/translations/backend-en.json', import.meta.url), 'utf8'));

test('language choice follows the system or an explicit preference', () => {
  assert.equal(resolveLanguage('system', 'zh-Hans-CN'), 'zh');
  assert.equal(resolveLanguage('system', 'en-US'), 'en');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh', 'en-US'), 'zh');
});

test('translates labels and placeholders without translating user-provided values', () => {
  assert.equal(translateText('zh', '保存', [], catalog), '保存');
  assert.equal(translateText('en', '保存', [], catalog), 'Save');
  assert.equal(translateText('en', '删除“{0}”？', ['文章'], catalog), 'Delete “文章”?');
  assert.equal(translateText('en', 'untranslated user content', [], catalog), 'untranslated user content');
});

test('translates known backend messages but preserves unknown details', () => {
  const input = '文章已被修改，请重新读取后再保存';
  assert.equal(translateBackend('zh', input, backend), input);
  assert.equal(translateBackend('en', input, backend), 'The article was changed. Reload it before saving');
  assert.equal(translateBackend('en', '无法打开工作目录：/用户/路径', backend), "Couldn't open workspace: /用户/路径");
  assert.equal(translateBackend('en', 'unknown error 例子', backend), 'unknown error 例子');
});

test('all static UI translation keys exist and retain their placeholders', () => {
  const files = ['AgentPicker.tsx', 'ArticleEditor.tsx', 'ContentWorkspace.tsx', 'PublicationCalendar.tsx', 'SocialPlatforms.tsx', 'main.tsx'];
  const keys = new Set();
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const placeholders = text => [...new Set(text.match(/\{\d+\}/g) || [])].sort();
  for (const key of keys) {
    assert.ok(Object.hasOwn(catalog, key), `Missing English translation: ${key}`);
    assert.deepEqual(placeholders(catalog[key]), placeholders(key), `Placeholder mismatch: ${key}`);
  }
});
