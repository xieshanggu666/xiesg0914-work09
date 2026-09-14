'use strict';
/* 主题词包：纯逻辑模块，浏览器（window.WTPacks）与 Node（测试）共用。
   词包 = 名称 + 主题说明 + 起始词候选列表，由玩家在首页「我的词包」中维护，
   数据只保存在本浏览器（localStorage）；房主在大厅选用后，词包内容作为快照
   发给服务器进入房间状态，所有玩家开局前都能看到主题与候选词。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTPacks = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const MAX_PACKS = 20;      // 本机最多保存的词包数
  const MIN_WORDS = 3;       // 至少 3 个候选词（默认开局抽 3 个起始词）
  const MAX_WORDS = 60;
  const MAX_NAME_LEN = 12;
  const MAX_THEME_LEN = 60;
  const MAX_WORD_LEN = 12;   // 与对局接词的长度上限一致

  // 把文本框内容解析成候选词列表：按换行/逗号/顿号/分号/空白切分，
  // 去空白、去重（保留首次出现的顺序）。
  function parseWords(text) {
    const out = [];
    for (const raw of String(text || '').split(/[\n,，、;；\s]+/)) {
      const w = raw.trim();
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  }

  // 校验词包输入。input: { name, theme, wordsText }（wordsText 为文本框原文）
  // 或 { name, theme, words }（已是数组）。返回 { errors, pack }：
  // errors 以字段为索引，为空对象表示通过；pack 为清洗后的 { name, theme, words }。
  function validatePack(input) {
    const errors = {};
    const name = String(input.name || '').trim();
    if (!name) errors.name = '请填写词包名称';
    else if (name.length > MAX_NAME_LEN) errors.name = `名称最多 ${MAX_NAME_LEN} 个字`;
    const theme = String(input.theme || '').trim();
    if (theme.length > MAX_THEME_LEN) errors.theme = `主题说明最多 ${MAX_THEME_LEN} 个字`;
    const words = Array.isArray(input.words)
      ? parseWords(input.words.join('\n'))
      : parseWords(input.wordsText);
    const tooLong = words.find(w => w.length > MAX_WORD_LEN);
    if (tooLong) errors.words = `「${tooLong}」超过 ${MAX_WORD_LEN} 个字`;
    else if (words.length < MIN_WORDS) errors.words = `至少需要 ${MIN_WORDS} 个候选词（当前 ${words.length} 个）`;
    else if (words.length > MAX_WORDS) errors.words = `最多 ${MAX_WORDS} 个候选词`;
    return { errors, pack: { name, theme, words } };
  }

  function makeId() {
    return `pk_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e8).toString(36)}`;
  }

  // 新增或更新（按 id 匹配），返回 { packs, error }。
  // 新建时超出 MAX_PACKS 拒绝；更新已存在的 id 不受数量限制。
  function upsert(packs, pack) {
    const list = Array.isArray(packs) ? packs.slice() : [];
    if (!pack || !pack.id) return { packs: list, error: '词包数据无效' };
    const idx = list.findIndex(p => p.id === pack.id);
    if (idx >= 0) {
      list[idx] = pack;
      return { packs: list, error: null };
    }
    if (list.length >= MAX_PACKS) return { packs: list, error: `最多保存 ${MAX_PACKS} 个词包，先删除一些再新建` };
    return { packs: [pack, ...list], error: null };
  }

  function remove(packs, id) {
    return (Array.isArray(packs) ? packs : []).filter(p => p.id !== id);
  }

  function find(packs, id) {
    return (Array.isArray(packs) ? packs : []).find(p => p.id === id) || null;
  }

  return {
    MAX_PACKS, MIN_WORDS, MAX_WORDS, MAX_NAME_LEN, MAX_THEME_LEN, MAX_WORD_LEN,
    parseWords, validatePack, makeId, upsert, remove, find,
  };
});
