import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanbanViewsNeedingGroup, pickGroupProperty, setViewGroupBy } from '../src/kanban.ts';

test('only kanban views new to kanban are grouped, so opening an existing base changes nothing', () => {
	const views = [
		{ name: '새 칸반', type: 'kanban', groupBy: null },
		{ name: '묶인 칸반', type: 'kanban', groupBy: '상태' },
		{ name: '표', type: 'table', groupBy: null },
		{ name: '카드', type: 'cards', groupBy: null },
		{ name: '목록', type: 'list', groupBy: null },
	];
	// first time this session an existing file is read: leave it alone
	assert.deepEqual(kanbanViewsNeedingGroup(views, null), []);
	// a base file created while the plugin runs: group its ungrouped kanban views
	assert.deepEqual(kanbanViewsNeedingGroup(views, null, true), ['새 칸반']);
	// a table that just became a kanban is new to kanban: group it
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'table', groupBy: null }]), ['A']);
	// a kanban view that was just added: group it
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'table', groupBy: null }, { name: 'B', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'table', groupBy: null }]), ['B']);
	// a kanban that had a group property a moment ago: the user removed it, leave it alone
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'kanban', groupBy: '상태' }]), []);
	// a kanban that was already ungrouped stays as it is (the start button is offered instead)
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'kanban', groupBy: null }]), []);
});

test('the group property is the status-like property most notes use, else the fallback', () => {
	assert.equal(pickGroupProperty([{ status: 'todo' }, { 상태: '완료' }, { 상태: '보는 중' }], '상태'), '상태');
	assert.equal(pickGroupProperty([{ stage: 'draft' }, { stage: 'final' }, { 상태: 'x' }], 'status'), 'stage');
	assert.equal(pickGroupProperty([{ 장르: '영화' }, null, undefined, { status: '   ' }, { status: 3 }], 'status'), 'status');
	assert.equal(pickGroupProperty([], '상태'), '상태');
});

test('setViewGroupBy groups one view and keeps everything else', () => {
	const base = { filters: { and: ['file.inFolder("작품")'] }, views: [{ type: 'kanban', name: 'A', order: ['file.name'], image: 'note.cover' }, { type: 'kanban', name: 'B', groupBy: { property: '장르', direction: 'DESC' } }] };
	assert.equal(setViewGroupBy(base, 'A', '상태'), true);
	assert.deepEqual(base.views[0], { type: 'kanban', name: 'A', order: ['file.name'], image: 'note.cover', groupBy: { property: '상태', direction: 'ASC' } });
	assert.equal(setViewGroupBy(base, 'B', '상태'), false);
	assert.deepEqual(base.views[1].groupBy, { property: '장르', direction: 'DESC' });
	assert.equal(setViewGroupBy(base, 'missing', '상태'), false);
	assert.deepEqual(base.filters, { and: ['file.inFolder("작품")'] });
});
