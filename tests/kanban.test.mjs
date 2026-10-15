import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kanbanViewsNeedingGroup, pickGroupProperty, setViewGroupBy } from '../src/kanban.ts';

test('only kanban views without a group property are grouped, unless the user just removed it', () => {
	const views = [
		{ name: '새 칸반', type: 'kanban', groupBy: null },
		{ name: '묶인 칸반', type: 'kanban', groupBy: '상태' },
		{ name: '표', type: 'table', groupBy: null },
		{ name: '카드', type: 'cards', groupBy: null },
		{ name: '목록', type: 'list', groupBy: null },
	];
	assert.deepEqual(kanbanViewsNeedingGroup(views, null), ['새 칸반']);
	// a table that just became a kanban is new to kanban: group it
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'table', groupBy: null }]), ['A']);
	// a kanban that had a group property a moment ago: the user removed it, leave it alone
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'kanban', groupBy: '상태' }]), []);
	// a kanban that was already ungrouped (e.g. the setting was off) is grouped once it is on
	assert.deepEqual(kanbanViewsNeedingGroup([{ name: 'A', type: 'kanban', groupBy: null }], [{ name: 'A', type: 'kanban', groupBy: null }]), ['A']);
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
