import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editEmbedQuery, embedQueryText, embedShownView, embedViewSetting, sameValue } from '../src/embedQuery.ts';
import { emptyFormat, readLookFormat, readTableFormat, writeTableFormat } from '../src/tableFormat.ts';

const FIELDS = ['type', 'name', 'filters', 'groupBy', 'groupOrder', 'order', 'sort', 'limit', 'summaries'];

/**
 * A stand-in for the base Bases holds in memory for an embed: each view keeps its settings in
 * `data` behind get/set, set() saves, the base's own unknown keys sit in `unrecognizedData`.
 */
function embed(base) {
	const calls = [];
	const query = {
		views: [],
		unrecognizedData: {},
		saves: 0,
		save() {
			this.saves++;
		},
		getViewConfig(name) {
			return this.views.find((view) => view.name === name) ?? null;
		},
		toString() {
			const views = this.views.map((view) => {
				const out = {};
				for (const key of FIELDS) if (view[key] !== undefined) out[key] = view[key];
				return { ...out, ...view.data };
			});
			return JSON.stringify({ ...this.unrecognizedData, views });
		},
	};
	for (const raw of base.views) {
		const view = { data: {} };
		for (const [key, value] of Object.entries(structuredClone(raw))) {
			if (FIELDS.includes(key)) view[key] = value;
			else view.data[key] = value;
		}
		view.get = (key) => view.data[key];
		view.getAll = () => view.data;
		view.set = (key, value) => {
			calls.push([view.name, key, value]);
			if (value === null) delete view.data[key];
			else view.data[key] = value;
			query.save();
		};
		query.views.push(view);
	}
	for (const [key, value] of Object.entries(base)) if (key !== 'views') query.unrecognizedData[key] = structuredClone(value);
	const controller = { query, viewName: base.views[0].name, view: { type: base.views[0].type } };
	// What the plugin edits: the embed's text, read back as an object.
	const draft = () => JSON.parse(embedQueryText(controller));
	return { controller, query, calls, draft };
}

const drinks = () => ({
	achmageLook: { thumbnailProperty: '썸네일', fittedColumns: { '전체 목록': 120 } },
	filters: { and: ['note["노트유형"] == "N번째음료"'] },
	views: [
		{
			type: 'table', name: '전체 목록', order: ['회차', 'file.name'], sort: [{ property: '회차', direction: 'ASC' }],
			columnSize: { 'file.name': 240 }, rowHeight: 'medium',
			achmageLook: { format: { header: { 'note.회차': { light: { fill: '#002E6E', text: '#FFFFFF' }, bold: true } } } },
		},
		{ type: 'cards', name: '음료 갤러리', order: ['file.name'], image: 'note.썸네일' },
	],
});

test('a format change sets only the plugin key of that view, through Bases', () => {
	const { controller, query, calls, draft } = embed(drinks());
	const edited = draft();
	writeTableFormat(edited, '전체 목록', { kind: 'header', props: ['file.name'] }, { theme: 'light', fill: '#002E6E', text: '#FFFFFF', bold: true });
	assert.equal(editEmbedQuery(controller, edited), true);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].slice(0, 2), ['전체 목록', 'achmageLook']);
	const format = readLookFormat(embedViewSetting(controller, '전체 목록', 'achmageLook'));
	assert.deepEqual(format.header['file.name'], { light: { fill: '#002E6E', text: '#FFFFFF' }, bold: true });
	assert.deepEqual(format.header['note.회차'], { light: { fill: '#002E6E', text: '#FFFFFF' }, bold: true });
	// The other view and the other settings stay as they were.
	assert.deepEqual(query.getViewConfig('음료 갤러리').data, { image: 'note.썸네일' });
	assert.deepEqual(query.getViewConfig('전체 목록').data.columnSize, { 'file.name': 240 });
	assert.equal(query.saves, 1);
});

test('nothing changed: nothing is set and nothing saved', () => {
	const { controller, query, calls, draft } = embed(drinks());
	assert.equal(editEmbedQuery(controller, draft()), true);
	assert.deepEqual(calls, []);
	assert.equal(query.saves, 0);
});

test('settings removed in the edit are removed, new ones added', () => {
	const { controller, query, calls, draft } = embed(drinks());
	const edited = draft();
	delete edited.views[0].columnSize;
	edited.views[0].rowHeight = 'tall';
	assert.equal(editEmbedQuery(controller, edited), true);
	assert.deepEqual(calls.map(([view, key, value]) => [view, key, value]), [['전체 목록', 'rowHeight', 'tall'], ['전체 목록', 'columnSize', null]]);
	assert.equal('columnSize' in query.getViewConfig('전체 목록').data, false);
	assert.equal(query.getViewConfig('전체 목록').data.rowHeight, 'tall');
});

test('fields of a view (order, sort, filters …) are not taken as settings', () => {
	const { controller, calls, draft } = embed(drinks());
	const edited = draft();
	edited.views[0].order = ['file.name'];
	edited.views[0].sort = [];
	edited.views[1].type = 'list';
	assert.equal(editEmbedQuery(controller, edited), true);
	assert.deepEqual(calls, []);
});

test("the base's own achmageLook (fitted thumbnail columns) goes to the base, once", () => {
	const { controller, query, calls, draft } = embed(drinks());
	const edited = draft();
	edited.achmageLook.fittedColumns['전체 목록'] = 164;
	edited.views[0].columnSize['formula.썸네일'] = 164;
	assert.equal(editEmbedQuery(controller, edited), true);
	assert.deepEqual(query.unrecognizedData.achmageLook.fittedColumns, { '전체 목록': 164 });
	assert.equal(query.unrecognizedData.achmageLook.thumbnailProperty, '썸네일');
	assert.equal(calls.length, 1);
	assert.equal(query.saves, 2);
	// A base whose achmageLook goes away loses the key.
	const again = draft();
	delete again.achmageLook;
	editEmbedQuery(controller, again);
	assert.equal('achmageLook' in query.unrecognizedData, false);
});

test('an edit that does not match the views of the embed changes nothing', () => {
	const { controller, calls, draft } = embed(drinks());
	const renamed = draft();
	renamed.views[0].name = '다른 이름';
	renamed.views[0].rowHeight = 'tall';
	assert.equal(editEmbedQuery(controller, renamed), false);
	const fewer = draft();
	fewer.views.pop();
	assert.equal(editEmbedQuery(controller, fewer), false);
	assert.equal(editEmbedQuery(controller, {}), false);
	assert.deepEqual(calls, []);
	// Two views with one name: which one a key belongs to is not known.
	const twins = drinks();
	twins.views[1].name = '전체 목록';
	const doubled = embed(twins);
	const edited = doubled.draft();
	edited.views[0].rowHeight = 'tall';
	assert.equal(editEmbedQuery(doubled.controller, edited), false);
	assert.deepEqual(doubled.calls, []);
});

test('controllers of another shape are left alone', () => {
	assert.equal(editEmbedQuery({}, { views: [] }), false);
	assert.equal(editEmbedQuery({ query: { views: [] } }, { views: [] }), false);
	assert.equal(embedQueryText({ query: { views: [], getViewConfig() {}, save() {} } }), null);
	assert.equal(embedQueryText(null), null);
	assert.equal(embedViewSetting({}, '전체 목록', 'achmageLook'), undefined);
	const throwing = { query: { views: [], getViewConfig() {}, save() {}, toString() { throw new Error('broken'); } } };
	assert.equal(embedQueryText(throwing), null);
});

test('the view an embed shows: its layout and name', () => {
	const { controller } = embed(drinks());
	assert.deepEqual(embedShownView(controller), { type: 'table', name: '전체 목록' });
	assert.deepEqual(embedShownView({ viewName: '', view: null }), { type: null, name: null });
	assert.deepEqual(embedShownView(null), { type: null, name: null });
});

test('values compare as YAML values: keys in any order, lists in order', () => {
	assert.equal(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
	assert.equal(sameValue([1, 2], [2, 1]), false);
	assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
	assert.equal(sameValue(null, null), true);
	assert.equal(sameValue(null, {}), false);
	assert.equal(sameValue('#002E6E', '#002E6E'), true);
	assert.equal(sameValue([], {}), false);
});

test('a format read from an achmageLook value equals the one read from the base', () => {
	const base = drinks();
	assert.deepEqual(readLookFormat(base.views[0].achmageLook), readTableFormat(base, '전체 목록'));
	assert.deepEqual(readLookFormat(undefined), emptyFormat());
	assert.deepEqual(readLookFormat({ format: 'not a format' }), emptyFormat());
	assert.deepEqual(readLookFormat({ format: { header: { 'note.회차': { light: { fill: 'navy' } } } } }), emptyFormat());
});
