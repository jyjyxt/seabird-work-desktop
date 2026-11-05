import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPickerKeyAction } from '../src/agentPickerKeys.ts';

test('arrow and boundary keys navigate and wrap through agents', () => {
  assert.deepEqual(agentPickerKeyAction('ArrowDown', 0, 2), { kind: 'highlight', index: 1 });
  assert.deepEqual(agentPickerKeyAction('ArrowDown', 1, 2), { kind: 'highlight', index: 0 });
  assert.deepEqual(agentPickerKeyAction('ArrowUp', 0, 2), { kind: 'highlight', index: 1 });
  assert.deepEqual(agentPickerKeyAction('Home', 1, 2), { kind: 'highlight', index: 0 });
  assert.deepEqual(agentPickerKeyAction('End', 0, 2), { kind: 'highlight', index: 1 });
});

test('enter or space selects, escape closes, and unrelated keys pass through', () => {
  assert.deepEqual(agentPickerKeyAction('Enter', 1, 2), { kind: 'select', index: 1 });
  assert.deepEqual(agentPickerKeyAction(' ', 0, 2), { kind: 'select', index: 0 });
  assert.deepEqual(agentPickerKeyAction('Escape', 0, 2), { kind: 'close' });
  assert.equal(agentPickerKeyAction('Tab', 0, 2), null);
  assert.equal(agentPickerKeyAction('ArrowDown', 0, 0), null);
});
