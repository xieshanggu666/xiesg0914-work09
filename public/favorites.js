'use strict';
/* 个人收藏本：纯逻辑模块，浏览器（window.WTFav）与 Node（测试）共用。
   把赛后回放里值得反复看的连接存成可复习的词语资料：
   保存一条连接的前词、后词、关系、原解释与来源房间，并支持搜索、筛选、笔记与复习。
   数据只保存在本浏览器（localStorage），不经过服务器。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTFav = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const RELATION_NAMES = {
    synonym: '同义/近义', antonym: '反义/对立', hypernym: '上下位',
    part: '部分-整体', cause: '因果', tool: '工具-用途',
    scene: '场景共现', derive: '词形/谐音衍生',
  };
  const relationName = (id) => RELATION_NAMES[id] || id;

  // 由回放中的一条节点（连接）构造收藏条目。
  // node：回放帧上的子节点；parent：同一帧中它的父节点；
  // relationTypes：本局的关系类型表（{id,name}[]），取不到名字时回退到内置表。
  // 不合法（起始词/无父词/无关系）时返回 null。
  function makeEntry(node, parent, opts = {}) {
    if (!node || !parent) return null;
    if (!node.parentId || !node.ownerId) return null;   // 起始词/根词不是一条可收藏的连接
    if (!node.relation) return null;
    const types = Array.isArray(opts.relationTypes) ? opts.relationTypes : [];
    const t = types.find(x => x && x.id === node.relation);
    return {
      key: connectionKey(node, opts.roomCode),
      front: String(parent.word || ''),
      back: String(node.word || ''),
      relation: node.relation,
      relationName: t ? t.name : relationName(node.relation),
      reason: String(node.reason || ''),
      roomCode: opts.roomCode ? String(opts.roomCode) : '',
      savedAt: Date.now(),
      note: '',
      // 复习状态：new 未复习；known 记住了；needReview 还要复习
      status: 'new',
      reviewedCount: 0,
      lastReviewedAt: null,
    };
  }

  // 同一条连接的去重键：同一房间同一节点即视为同一条（防止回放里重复收藏）
  function connectionKey(node, roomCode) {
    return `${roomCode || ''}#${node.id}`;
  }

  // 加入一条收藏；已存在同键条目时保留旧条目（不覆盖笔记/复习状态），返回 { entries, added }
  function add(entries, entry) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    if (!entry || !entry.key) return { entries: list, added: false };
    if (list.some(e => e.key === entry.key)) return { entries: list, added: false };
    return { entries: [entry, ...list], added: true };
  }

  function remove(entries, key) {
    return (Array.isArray(entries) ? entries : []).filter(e => e.key !== key);
  }

  function updateNote(entries, key, note) {
    return (Array.isArray(entries) ? entries : []).map(e =>
      e.key === key ? { ...e, note: String(note || '') } : e);
  }

  // 按词语搜索（匹配前词或后词，忽略大小写），可再按关系筛选
  function filter(entries, { keyword = '', relation = '' } = {}) {
    const kw = String(keyword || '').trim().toLowerCase();
    return (Array.isArray(entries) ? entries : []).filter(e => {
      if (relation && e.relation !== relation) return false;
      if (!kw) return true;
      return e.front.toLowerCase().includes(kw) || e.back.toLowerCase().includes(kw);
    });
  }

  // 收藏中出现过的全部关系类型（用于筛选下拉），按首次收藏顺序
  function usedRelations(entries) {
    const seen = new Set();
    const out = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!seen.has(e.relation)) {
        seen.add(e.relation);
        out.push({ id: e.relation, name: e.relationName || relationName(e.relation) });
      }
    }
    return out;
  }

  // ---------- 复习模式 ----------
  // 复习队列：先复习「还要复习」的，没有这类时再复习全部（简单 SRS：状态即间隔标记）。
  // 返回新数组（不修改入参），新收藏（new）排在已记住的前面。
  function reviewQueue(entries) {
    const list = Array.isArray(entries) ? entries.slice() : [];
    const need = list.filter(e => e.status === 'needReview');
    if (need.length) {
      return need.sort((a, b) => (a.lastReviewedAt || 0) - (b.lastReviewedAt || 0));
    }
    return list.sort((a, b) => {
      const rank = { needReview: 0, new: 1, known: 2 };
      const ra = rank[a.status] ?? 1, rb = rank[b.status] ?? 1;
      if (ra !== rb) return ra - rb;
      return (a.lastReviewedAt || 0) - (b.lastReviewedAt || 0);
    });
  }

  // 开始一次复习：复制队列，游标在 0；空列表时返回 null
  function startReview(entries) {
    const queue = reviewQueue(entries);
    if (!queue.length) return null;
    return { queue, idx: 0, revealed: false, finished: false };
  }

  const current = (session) =>
    session && !session.finished ? session.queue[session.idx] : null;

  function reveal(session) {
    if (!session || session.finished) return session;
    return { ...session, revealed: true };
  }

  // 标记当前卡片：known（记住了）或 needReview（还要复习）。
  // 同步更新对应条目的复习状态；走到队尾则 finished。返回 { session, entries }。
  function mark(session, entries, verdict) {
    if (!session || session.finished) return { session, entries: entries || [] };
    const list = Array.isArray(entries) ? entries : [];
    const card = session.queue[session.idx];
    const status = verdict === 'known' ? 'known' : 'needReview';
    const nextEntries = list.map(e => e.key === card.key
      ? { ...e, status, reviewedCount: e.reviewedCount + 1, lastReviewedAt: Date.now() }
      : e);
    const queue = session.queue.map(e => e.key === card.key
      ? { ...e, status, reviewedCount: e.reviewedCount + 1 }
      : e);
    const idx = session.idx + 1;
    const nextSession = {
      ...session, queue, revealed: false,
      idx, finished: idx >= queue.length,
    };
    return { session: nextSession, entries: nextEntries };
  }

  // 本次复习的进度统计：已标记数 / 总数，其中「还要复习」的条数
  function progress(session) {
    if (!session) return { done: 0, total: 0, needReview: 0 };
    const done = session.finished ? session.queue.length : session.idx;
    return {
      done, total: session.queue.length,
      needReview: session.queue.slice(0, done).filter(e => e.status === 'needReview').length,
    };
  }

  // 收藏本整体统计：总数、已记住、还要复习、未复习
  function stats(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return {
      total: list.length,
      known: list.filter(e => e.status === 'known').length,
      needReview: list.filter(e => e.status === 'needReview').length,
      fresh: list.filter(e => e.status === 'new').length,
    };
  }

  return {
    relationName, makeEntry, connectionKey, add, remove, updateNote,
    filter, usedRelations, reviewQueue,
    startReview, current, reveal, mark, progress, stats,
  };
});
