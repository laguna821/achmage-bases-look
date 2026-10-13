import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHex, readGroupColors, writeGroupColors, autoColors, PALETTE, STORE_KEY } from '../src/groups.ts';

test('normalizeHex accepts common spellings and rejects the rest', () => {
	assert.equal(normalizeHex('#0090ff'), '#0090FF');
	assert.equal(normalizeHex('0090FF'), '#0090FF');
	assert.equal(normalizeHex(' #abc '), '#AABBCC');
	assert.equal(normalizeHex('red'), null);
	assert.equal(normalizeHex('#12345'), null);
});

test('group colors round-trip through the base and keep other keys', () => {
	const base = { views: [], [STORE_KEY]: { other: 1 } };
	writeGroupColors(base, { '보고 싶음': '#0090ff', 완료: 'nonsense' });
	assert.deepEqual(readGroupColors(base), { '보고 싶음': '#0090FF' });
	assert.equal(base[STORE_KEY].other, 1);
	writeGroupColors(base, { '보고 싶음': null });
	assert.deepEqual(readGroupColors(base), {});
	assert.deepEqual(base[STORE_KEY], { other: 1 });
});

test('clearing the last color removes the store from the base', () => {
	const base = { views: [] };
	writeGroupColors(base, { a: '#111111' });
	writeGroupColors(base, { a: null });
	assert.equal(STORE_KEY in base, false);
});

test('readGroupColors ignores broken data', () => {
	assert.deepEqual(readGroupColors({ [STORE_KEY]: 'x' }), {});
	assert.deepEqual(readGroupColors({ [STORE_KEY]: { groupColors: { a: 5, b: '#zzzzzz', c: '#123456' } } }), { c: '#123456' });
});

test('autoColors fills only empty groups with unused palette colors', () => {
	const existing = { a: PALETTE[0] };
	const result = autoColors(['a', 'b', 'c'], existing);
	assert.deepEqual(Object.keys(result), ['b', 'c']);
	assert.equal(result.b, PALETTE[1]);
	assert.equal(result.c, PALETTE[2]);
	const many = autoColors(Array.from({ length: 10 }, (_, i) => `g${i}`), {});
	assert.equal(Object.keys(many).length, 10);
	assert.equal(many.g8, PALETTE[0]);
});

test('group style overrides are stored per base and validated', async () => {
	const { readGroupStyle, writeGroupStyle } = await import('../src/groups.ts');
	const base = { views: [] };
	writeGroupStyle(base, { border: false, tint: 99 });
	assert.deepEqual(readGroupStyle(base), { border: false, tint: 40 });
	writeGroupStyle(base, { border: undefined, tint: undefined });
	assert.equal(STORE_KEY in base, false);
	assert.deepEqual(readGroupStyle({ [STORE_KEY]: { groupStyle: { background: 'yes', heading: true } } }), { heading: true });
});
