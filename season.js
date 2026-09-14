'use strict';
// 赛季战绩 —— 纯逻辑状态（无任何 IO），服务端与测试共用。
//
// 玩家完成对局后，服务端从已结束的房间里为每名玩家汇总一条"可公开展示"的赛季记录：
// 场次、胜场、平局、总得分、平均得分、最高连锁、最近对局时间。排行榜据此排序，
// 个人页据此展示汇总。
//
// 身份与防伪：公开的玩家标识 pid 不是客户端自报的，而是由服务端从客户端持有的
// 随机密钥派生——pid = sha256(pidSecret)。客户端在建房/加入时提交的是 pidSecret，
// 服务端据此算出 pid。这样只有持有某把密钥的人才能认领对应的 pid：排行榜公开的只是
// pid（密钥的单向哈希），别人看到 pid 也无法反推出密钥、更无法把自己的对局记到别人
// 名下，杜绝"冒用他人公开标识污染战绩"。观战是临时只读身份，从不参与对局，不进战绩。

const crypto = require('crypto');
const game = require('./game');

// pidSecret：32 字节随机数的十六进制串（64 位），只存在玩家自己浏览器里，永不上榜
const PID_SECRET_RE = /^[a-f0-9]{64}$/;
// pid：密钥的 sha256 十六进制摘要（64 位），可公开（排行榜/个人页/房间内）
const PID_RE = /^[a-f0-9]{64}$/;
const SORTS = new Set(['total', 'wins', 'rate']);

// 由玩家密钥派生公开标识：pid = sha256(secret)。非法密钥返回 null（调用方据此拒绝/匿名）
function derivePid(secret) {
  if (typeof secret !== 'string' || !PID_SECRET_RE.test(secret)) return null;
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function isValidPid(pid) { return typeof pid === 'string' && PID_RE.test(pid); }
function isValidPidSecret(secret) { return typeof secret === 'string' && PID_SECRET_RE.test(secret); }

// 统一解析身份凭据：优先认密钥（派生出 pid），密钥非法时不接受任何自报 pid，
// 避免"直接提交别人的 pid"这种冒用。返回 { pid } 或 { pid: null }（匿名/不进战绩）。
function resolvePid({ pid, pidSecret } = {}) {
  if (isValidPidSecret(pidSecret)) return { pid: derivePid(pidSecret) };
  return { pid: null };
}

function emptySeason(now = Date.now()) {
  return { version: 1, startedAt: now, players: {} };
}

// 兼容旧/脏存档：缺字段补零、非法条目丢弃，保证后续聚合不会读到脏数据
function normalizeSeason(raw, now = Date.now()) {
  const season = emptySeason(Number(raw && raw.startedAt) || now);
  const entries = raw && typeof raw === 'object' && raw.players && typeof raw.players === 'object'
    ? Object.entries(raw.players) : [];
  for (const [pid, p] of entries) {
    if (!PID_RE.test(pid) || !p || typeof p !== 'object') continue;
    season.players[pid] = {
      pid,
      name: String(p.name || '玩家').slice(0, 12),
      games: Math.max(0, Math.trunc(Number(p.games) || 0)),
      wins: Math.max(0, Math.trunc(Number(p.wins) || 0)),
      ties: Math.max(0, Math.trunc(Number(p.ties) || 0)),
      totalScore: Math.max(0, Math.trunc(Number(p.totalScore) || 0)),
      bestChain: Math.max(0, Math.trunc(Number(p.bestChain) || 0)),
      lastAt: Math.max(0, Math.trunc(Number(p.lastAt) || 0)),
    };
  }
  return season;
}

function isValidPid(pid) { return typeof pid === 'string' && PID_RE.test(pid); }

// 由一名玩家的赛季原始记录派生展示用汇总（平均得分、胜率、负场均为派生值，不入库）
function aggregate(stat) {
  const games = stat.games;
  return {
    games,
    wins: stat.wins,
    ties: stat.ties,
    losses: Math.max(0, games - stat.wins - stat.ties),
    totalScore: stat.totalScore,
    avgScore: games ? Math.round((stat.totalScore / games) * 10) / 10 : 0,
    bestChain: stat.bestChain,
    winRate: games ? stat.wins / games : 0,
    lastAt: stat.lastAt,
  };
}

// 把一个已结束房间计入赛季。每个房间只计一次（room.seasonRecorded 幂等标记，
// 防止结算广播重入、服务器重启后重复累计）。无 pid 的玩家（旧客户端/观战者）跳过。
// 返回 { changed, recorded }：recorded 为本次实际计入的玩家数。
function recordRoom(season, room, now = Date.now()) {
  if (!season.players) season.players = {};
  if (!room || room.phase !== 'ended' || room.seasonRecorded) {
    return { changed: false, recorded: 0 };
  }
  const scores = game.computeScores(room);
  const scoreOf = new Map(scores.map(s => [s.playerId, s]));
  let recorded = 0;
  for (const p of room.players) {
    if (!isValidPid(p.pid)) continue;
    const row = scoreOf.get(p.id);
    if (!row) continue;
    const stat = season.players[p.pid] || {
      pid: p.pid, name: p.name, games: 0, wins: 0, ties: 0,
      totalScore: 0, bestChain: 0, lastAt: 0,
    };
    // 昵称以最近一局为准
    stat.name = p.name;
    stat.games += 1;
    if (room.winner === p.id) stat.wins += 1;
    else if (!room.winner) stat.ties += 1; // 平局（并列最高分）：人人算平、无人算负
    stat.totalScore += row.total;
    stat.bestChain = Math.max(stat.bestChain, row.longestChain || 0);
    stat.lastAt = room.endedAt || now;
    season.players[p.pid] = stat;
    recorded += 1;
  }
  room.seasonRecorded = true;
  return { changed: recorded > 0, recorded };
}

// 三种排序都有稳定的次级依据，同分同胜场时顺序不抖动：
// total 总分→胜场→场次→昵称→pid；wins 胜场→场次→总分→…；rate 胜率→场次→总分→…
function compareRows(a, b, sort) {
  const byName = () => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.pid.localeCompare(b.pid);
  if (sort === 'wins') {
    return b.wins - a.wins || b.games - a.games || b.totalScore - a.totalScore || byName();
  }
  if (sort === 'rate') {
    return b.winRate - a.winRate || b.games - a.games || b.totalScore - a.totalScore || byName();
  }
  return b.totalScore - a.totalScore || b.wins - a.wins || b.games - a.games || byName();
}

// 排行榜：所有有已结束对局的玩家，按指定维度排序并附上名次。
function leaderboard(season, opts = {}) {
  const sort = SORTS.has(opts.sort) ? opts.sort : 'total';
  const rows = Object.values(season.players || {}).map(stat => ({
    pid: stat.pid, name: stat.name, ...aggregate(stat),
  }));
  rows.sort((a, b) => compareRows(a, b, sort));
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

// 个人页：单个玩家的赛季汇总，并附带其在总分榜上的名次；无记录返回 null。
function getProfile(season, pid) {
  if (!isValidPid(pid)) return null;
  const stat = (season.players || {})[pid];
  if (!stat) return null;
  const rank = leaderboard(season, { sort: 'total' }).find(r => r.pid === pid);
  return { pid: stat.pid, name: stat.name, rank: rank ? rank.rank : null, ...aggregate(stat) };
}

module.exports = {
  PID_RE, PID_SECRET_RE, SORTS,
  emptySeason, normalizeSeason, isValidPid, isValidPidSecret,
  derivePid, resolvePid,
  aggregate, recordRoom, leaderboard, getProfile,
};
