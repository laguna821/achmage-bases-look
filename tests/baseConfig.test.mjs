import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	enable, disable, isEnabled, applyLook, readLook, findThumbnailFormula, thumbnailFormula, cardSizeFor, columnWidthFor, rowHeightFor, listPixelsFor,
} from '../src/baseConfig.ts';

const sample = () => ({
	filters: { and: ['file.inFolder("작품")'] },
	views: [
		{ type: 'kanban', name: 'Board', groupBy: { property: 'note.상태', direction: 'ASC' }, order: ['file.name'] },
		{ type: 'cards', name: 'Cards', order: ['file.name'] },
		{ type: 'table', name: 'Table', order: ['file.name', 'note.장르'] },
		{ type: 'list', name: 'List' },
		{ type: 'map', name: 'Map' },
	],
});

const look = { size: null, ratio: 'landscape', fit: null };


test('enable sets the image property on cover views and a formula column on table and list', () => {
	const base = enable(sample(), '썸네일', look);
	assert.equal(base.views[0].image, 'note.썸네일');
	assert.equal(base.views[1].image, 'note.썸네일');
	assert.equal(base.views[0].imageAspectRatio, 0.75);
	assert.deepEqual(base.views[2].order, ['formula.썸네일', 'file.name', 'note.장르']);
	assert.deepEqual(base.views[3].order, ['formula.썸네일', 'file.name']);
	assert.equal(base.views[2].rowHeight, 'tall');
	assert.equal(base.views[3].rowHeight, undefined);
	assert.equal(base.formulas['썸네일'], 'image(note.썸네일)');
	assert.equal(base.views[4].image, undefined);
	assert.equal(isEnabled(base, '썸네일'), true);
});

test('enable twice does not duplicate the formula column', () => {
	const base = enable(enable(sample(), 'cover', look), 'cover', look);
	assert.deepEqual(base.views[2].order, ['formula.cover', 'file.name', 'note.장르']);
	assert.deepEqual(Object.keys(base.formulas), ['cover']);
});

test('a formula name that is taken by something else gets a new name', () => {
	const base = sample();
	base.formulas = { cover: 'file.name' };
	enable(base, 'cover', look);
	assert.equal(base.formulas.cover, 'file.name');
	assert.equal(base.formulas['cover 2'], 'image(note.cover)');
	assert.equal(findThumbnailFormula(base, 'cover'), 'cover 2');
});

test('property names with spaces use bracket syntax in the formula', () => {
	assert.equal(thumbnailFormula('my cover'), 'image(note["my cover"])');
	assert.equal(thumbnailFormula('썸네일'), 'image(note.썸네일)');
});

test('disable removes only what enable added', () => {
	const base = enable(sample(), 'cover', look);
	base.views[0].groupBy = { property: 'note.상태', direction: 'ASC' };
	disable(base, 'cover');
	assert.equal(base.views[0].image, undefined);
	assert.deepEqual(base.views[2].order, ['file.name', 'note.장르']);
	assert.equal(base.formulas, undefined);
	assert.equal(isEnabled(base, 'cover'), false);
	assert.deepEqual(base.views[0].groupBy, { property: 'note.상태', direction: 'ASC' });
});

test('disable keeps image settings that point at another property', () => {
	const base = sample();
	base.views[0].image = 'note.poster';
	disable(base, 'cover');
	assert.equal(base.views[0].image, 'note.poster');
});

test('an image setting without the note. prefix counts as enabled', () => {
	const base = sample();
	base.views[0].image = 'cover';
	assert.equal(isEnabled(base, 'cover'), true);
});

test('applyLook writes size, shape and fit per view type and readLook reads them back', () => {
	const base = enable(sample(), 'cover', look);
	applyLook(base, 'cover', { size: 80, ratio: 'poster', fit: 'contain' });
	assert.equal(base.views[0].columnWidth, 412);
	assert.equal(base.views[1].cardSize, 348);
	assert.equal(base.views[1].imageAspectRatio, 1.5);
	assert.equal(base.views[1].imageFit, 'contain');
	assert.equal(base.views[2].rowHeight, 'extra');
	assert.deepEqual(readLook(base, 'cover'), { size: 80, ratio: 'poster', fit: 'contain' });
	applyLook(base, 'cover', { fit: 'cover' });
	assert.equal(base.views[1].imageFit, undefined);
});

test('a base without views is left alone', () => {
	const base = enable({ filters: {} }, 'cover', look);
	assert.equal(isEnabled(base, 'cover'), false);
	assert.equal(base.formulas, undefined);
});

test('the size scale maps to every view type and back', () => {
	assert.equal(cardSizeFor(0), 140);
	assert.equal(cardSizeFor(100), 400);
	assert.equal(columnWidthFor(45), 328);
	assert.equal(rowHeightFor(10), 'medium');
	assert.equal(rowHeightFor(50), 'tall');
	assert.equal(rowHeightFor(90), 'extra');
	assert.equal(listPixelsFor(150), 120);
	const base = { views: [{ type: 'table', order: ['file.name'] }] };
	enable(base, 'cover', { size: null, ratio: null, fit: null });
	applyLook(base, 'cover', { size: 90 });
	assert.equal(readLook(base, 'cover').size, 80);
});
