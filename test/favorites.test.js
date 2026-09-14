'use strict';
// 个人收藏本纯逻辑测试：收藏去重、搜索/筛选、笔记、删除，以及复习模式流程。
const test = require('node:test');
const assert = require('node:assert');
const F = require('../public/favorites.js');

function node(over = {}) {
  return { id: 'w1', word: '篝火', ownerId: 'p2', parentId: 'w0',
    relation: 'scene', reason: '篝火晚会上有火', reinforced: false, ...over };
}
function parent(over = {}) {
  return { id: 'w0', word: '火', ownerId: 'p1', parentId: 'start0',
    relation: 'hypernym', reason: '火焰是火', ...over };
}
const TYPES = [
  { id: 'scene', name: '场景共现' },
  { id: 'hypernym', name: '上下位' },
  { id: 'synonym', name: '同义/近义' },
];

test('makeEntry 保存前后词、关系、原解释与来源房间', () => {
  const e = F.makeEntry(node(), parent(), { roomCode: 'ABCD', relationTypes: TYPES });
  assert.ok(e.key.startsWith('ABCD#w1'));
  assert.strictEqual(e.front, '火');
  assert.strictEqual(e.back, '篝火');
  assert.strictEqual(e.relation, 'scene');
  assert.strictEqual(e.relationName, '场景共现');
  assert.strictEqual(e.reason, '篝火晚会上有火');
  assert.strictEqual(e.roomCode, 'ABCD');
  assert.strictEqual(e.note, '');
  assert.strictEqual(e.status, 'new');
  assert.strictEqual(e.reviewedCount, 0);
});

test('关系类型表缺失时回退到内置中文名', () => {
  const e = F.makeEntry(node(), parent(), { roomCode: 'ABCD' });
  assert.strictEqual(e.relationName, '场景共现');
});

test('起始词 / 无根 / 无关系的节点不能收藏', () => {
  assert.strictEqual(F.makeEntry(null, parent(), {}), null);
  assert.strictEqual(F.makeEntry(node(), null, {}), null);
  // 起始词：ownerId 为空
  assert.strictEqual(F.makeEntry(node({ ownerId: null, parentId: null, relation: null }), parent(), {}), null);
  // 级联后成为幸存根：parentId 已断开
  assert.strictEqual(F.makeEntry(node({ parentId: null }), parent(), {}), null);
});

test('add 同键去重，且不覆盖旧笔记/状态', () => {
  const e1 = F.makeEntry(node(), parent(), { roomCode: 'R' });
  let { entries, added } = F.add([], e1);
  assert.strictEqual(added, true);
  assert.strictEqual(entries.length, 1);
  // 同房间同节点再次收藏 → 忽略
  const again = F.add(entries, { ...e1, note: '新笔记' });
  assert.strictEqual(again.added, false);
  assert.strictEqual(again.entries.length, 1);
  assert.strictEqual(again.entries[0].note, '');
  // 不同房间的同节点 id 视为不同条目
  const other = F.add(entries, F.makeEntry(node(), parent(), { roomCode: 'S' }));
  assert.strictEqual(other.added, true);
  assert.strictEqual(other.entries.length, 2);
});

test('remove 按 key 删除，updateNote 更新笔记', () => {
  const e = F.makeEntry(node(), parent(), { roomCode: 'R' });
  let entries = F.add([], e).entries;
  entries = F.updateNote(entries, e.key, '好例子');
  assert.strictEqual(entries[0].note, '好例子');
  entries = F.remove(entries, e.key);
  assert.strictEqual(entries.length, 0);
  // 删除不存在的 key 不报错
  assert.deepStrictEqual(F.remove([], 'nope'), []);
});

test('filter 按前词/后词搜索（忽略大小写），可叠加关系筛选', () => {
  const a = F.makeEntry(node({ word: '篝火' }), parent({ word: '火' }), { roomCode: 'R' });
  const b = F.makeEntry(node({ id: 'w2', word: '火焰', relation: 'hypernym',
    reason: '火焰是火的一种形态' }), parent({ word: '火' }), { roomCode: 'R', relationTypes: TYPES });
  const c = F.makeEntry(node({ id: 'w3', word: '快乐', relation: 'synonym',
    reason: '开心' }), parent({ word: '开心' }), { roomCode: 'R', relationTypes: TYPES });
  let entries = [a, b, c].reduce((acc, e) => F.add(acc, e).entries, []);

  // 前词「火」(a、b 的父词) 命中 篝火 / 火焰；c（开心→快乐）不含火
  assert.strictEqual(F.filter(entries, { keyword: '火' }).length, 2);
  assert.strictEqual(F.filter(entries, { keyword: '篝火' }).length, 1);
  assert.strictEqual(F.filter(entries, { keyword: 'KAI' }).length, 0);
  assert.strictEqual(F.filter(entries, { keyword: '快乐' })[0].back, '快乐');
  // 关系筛选
  assert.strictEqual(F.filter(entries, { relation: 'scene' }).length, 1);
  // 关键词 + 关系叠加
  assert.strictEqual(F.filter(entries, { keyword: '火', relation: 'hypernym' }).length, 1);
  assert.strictEqual(F.filter(entries, { keyword: '火', relation: 'synonym' }).length, 0);
  // 无条件返回全部
  assert.strictEqual(F.filter(entries).length, 3);
});

test('usedRelations 按首次出现顺序去重', () => {
  const a = F.makeEntry(node({ relation: 'scene' }), parent(), { roomCode: 'R', relationTypes: TYPES });
  const b = F.makeEntry(node({ id: 'w2', relation: 'scene' }), parent(), { roomCode: 'R', relationTypes: TYPES });
  const c = F.makeEntry(node({ id: 'w3', relation: 'synonym' }), parent({ relation: 'synonym' }),
    { roomCode: 'R', relationTypes: TYPES });
  const entries = [a, b, c].reduce((acc, e) => F.add(acc, e).entries, []);
  // add 新条目置顶：c(synonym) 在前，a/b(scene) 去重后只留一个
  assert.deepStrictEqual(F.usedRelations(entries).map(r => r.id), ['synonym', 'scene']);
});

test('stats 统计总数 / 已记住 / 还要复习 / 未复习', () => {
  const e = F.makeEntry(node(), parent(), { roomCode: 'R' });
  let entries = F.add([], e).entries;
  assert.deepStrictEqual(F.stats(entries), { total: 1, known: 0, needReview: 0, fresh: 1 });
  let s = F.startReview(entries);
  let r = F.mark(s, entries, 'known');
  assert.strictEqual(r.entries[0].status, 'known');
  assert.deepStrictEqual(F.stats(r.entries), { total: 1, known: 1, needReview: 0, fresh: 0 });
});

test('复习流程：先展示前词与关系，揭示后才出现后词与判定按钮（由 UI 控制）；标记推进进度', () => {
  const e1 = F.makeEntry(node({ id: 'w1' }), parent({ word: '火' }), { roomCode: 'R' });
  const e2 = F.makeEntry(node({ id: 'w2', word: '火焰' }), parent({ word: '火' }), { roomCode: 'R' });
  let entries = [e1, e2].reduce((acc, e) => F.add(acc, e).entries, []);

  let s = F.startReview(entries);
  assert.strictEqual(s.revealed, false);
  // 收藏按最新在前，后收藏的「火焰」排第一张
  assert.strictEqual(F.current(s).back, '火焰');
  assert.deepStrictEqual(F.progress(s), { done: 0, total: 2, needReview: 0 });

  // 未揭示也可标记（按钮由 UI 隐藏）；先揭示再标记：火焰还要复习
  s = F.reveal(s);
  assert.strictEqual(s.revealed, true);
  let r = F.mark(s, entries, 'needReview');
  s = r.session; entries = r.entries;
  assert.strictEqual(s.revealed, false, '下一张应重新遮住');
  assert.strictEqual(F.current(s).back, '篝火');
  assert.deepStrictEqual(F.progress(s), { done: 1, total: 2, needReview: 1 });
  assert.strictEqual(entries.find(e => e.back === '火焰').status, 'needReview');
  assert.strictEqual(entries.find(e => e.back === '火焰').reviewedCount, 1);

  r = F.mark(s, entries, 'known');
  assert.strictEqual(r.session.finished, true);
  assert.strictEqual(F.current(r.session), null);
  assert.deepStrictEqual(F.progress(r.session), { done: 2, total: 2, needReview: 1 });
});

test('复习队列优先「还要复习」，没有时按 未复习 → 已记住 排列', () => {
  const mk = (id, status) => ({ key: `R#${id}`, front: 'a', back: id, relation: 'scene',
    relationName: '场景共现', reason: 'x', roomCode: 'R', savedAt: 0, note: '',
    status, reviewedCount: 0, lastReviewedAt: null });
  const known = mk('known', 'known');
  const fresh = mk('fresh', 'new');
  const need = mk('need', 'needReview');
  // 有 needReview：只复习它们
  let q = F.reviewQueue([known, fresh, need]);
  assert.deepStrictEqual(q.map(e => e.back), ['need']);
  // 没有 needReview：new 在前，known 在后
  q = F.reviewQueue([known, fresh]);
  assert.deepStrictEqual(q.map(e => e.back), ['fresh', 'known']);
  // 全已记住时复习 known（仍可再复习）
  q = F.reviewQueue([known]);
  assert.deepStrictEqual(q.map(e => e.back), ['known']);
  // 空列表
  assert.strictEqual(F.startReview([]), null);
});

test('mark 只更新匹配 key 的条目，不影响未参与本轮的收藏', () => {
  const inReview = F.makeEntry(node({ id: 'w1' }), parent(), { roomCode: 'R' });
  const other = F.makeEntry(node({ id: 'w9' }), parent(), { roomCode: 'R' });
  let entries = [inReview, other].reduce((acc, e) => F.add(acc, e).entries, []);
  const s = F.startReview([inReview]); // 本轮只复习一条
  const r = F.mark(s, entries, 'known');
  assert.strictEqual(r.entries.find(e => e.key === inReview.key).status, 'known');
  assert.strictEqual(r.entries.find(e => e.key === other.key).status, 'new');
});
