'use strict';
// 赛季战绩纯逻辑单测：对局汇总、幂等、平局、跨房聚合、排行榜排序与个人页汇总。
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');
const s = require('../season');

// 公开 pid 是 64 位十六进制（sha256 摘要形状）；这里直接用重复字符模拟其形状
const PID_A = 'a'.repeat(64);
const PID_B = 'b'.repeat(64);
const PID_C = 'c'.repeat(64);
// 三把玩家密钥（64 位十六进制），由服务端 derivePid 派生出各自公开 pid
const SECRET_A = '1'.repeat(64);
const SECRET_B = '2'.repeat(64);

// 造一局并打完：players 为 [{name, pid}]；moves 给每名玩家在其回合接的词（接到 start0 下）。
// 返回时房间已 ended，且每个玩家至少有一个词，分数可预测。
function playGame(names, { rounds = 1, chains = {} } = {}) {
  const players = names.map((name, i) => ({ name, pid: ['a', 'b', 'c'][i].repeat(64) }));
  const room = g.newRoom('CODE' + Math.floor(Math.random() * 1e6), 'p0', players[0].name);
  players.forEach((p, i) => g.addPlayer(room, `p${i}`, p.name, p.pid));
  const err = g.setRuleSet(room, 'p0', { rounds, startWordCount: 1 });
  assert.strictEqual(err, null);
  assert.strictEqual(g.startGame(room, 'p0', () => 0.01), null);
  // 每个玩家回合内接一个词到 start0，避免互相接词导致被质疑拆除的复杂局面
  const used = new Set();
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 100) {
    const idx = room.players.findIndex(p => p.id === room.turn.playerId);
    let word = `词${idx}-${room.turn.turnNumber}`;
    let n = 1;
    while (used.has(word)) word = `词${idx}-${room.turn.turnNumber}-${n++}`;
    used.add(word);
    g.playWord(room, room.turn.playerId, {
      word, parentId: 'start0', relation: 'synonym', reason: '足够长的关系解释',
    });
    g.endTurn(room, room.turn.playerId);
  }
  assert.strictEqual(room.phase, 'ended');
  return room;
}

test('pid 形状校验：只认 64 位十六进制（sha256 摘要形状）', () => {
  assert.strictEqual(s.isValidPid(PID_A), true);
  assert.strictEqual(s.isValidPid('a'.repeat(64)), true);
  for (const bad of ['', 'xyz', 'a'.repeat(16), 'a'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), null, 123]) {
    assert.strictEqual(s.isValidPid(bad), false);
  }
});

test('密钥校验：只认 64 位十六进制', () => {
  assert.strictEqual(s.isValidPidSecret(SECRET_A), true);
  for (const bad of ['', 'xyz', '1'.repeat(63), '1'.repeat(65), 'g'.repeat(64), null]) {
    assert.strictEqual(s.isValidPidSecret(bad), false);
  }
});

test('derivePid：合法密钥派生 64 位 pid，非法密钥返回 null，且确定/可区分', () => {
  const pidA = s.derivePid(SECRET_A);
  assert.ok(s.isValidPid(pidA));
  assert.strictEqual(pidA, s.derivePid(SECRET_A), '同一密钥派生结果确定');
  assert.notStrictEqual(pidA, s.derivePid(SECRET_B), '不同密钥派生不同 pid');
  assert.notStrictEqual(pidA, SECRET_A, 'pid 不应等于密钥本身');
  assert.strictEqual(s.derivePid('nope'), null);
});

test('resolvePid：只凭密钥认领 pid；自报他人 pid 一律拒绝（防冒用核心）', () => {
  // 正常：提交自己的密钥，派生出对应 pid
  assert.strictEqual(s.resolvePid({ pidSecret: SECRET_A }).pid, s.derivePid(SECRET_A));
  // 攻击：不提供密钥，直接提交从排行榜看到的受害者 pid —— 必须得到 null
  assert.strictEqual(s.resolvePid({ pid: PID_A }).pid, null);
  // 攻击：密钥非法，却同时塞一个受害者 pid —— 仍必须得到 null（pid 被忽略）
  assert.strictEqual(s.resolvePid({ pid: PID_A, pidSecret: 'forged' }).pid, null);
  assert.strictEqual(s.resolvePid({}).pid, null);
  assert.strictEqual(s.resolvePid().pid, null);
  // 即使提交的"密钥"恰好是别人的 pid（64 位十六进制），也只会派生出另一个无关 pid
  const spoof = s.resolvePid({ pidSecret: PID_A }).pid;
  assert.ok(s.isValidPid(spoof));
  assert.notStrictEqual(spoof, PID_A, '拿别人 pid 当密钥也无法认领该 pid');
});

test('一局结束：每名玩家计入一场，分数/最长链/胜者汇总正确且幂等', () => {
  const room = playGame(['甲', '乙']);
  const scores = g.computeScores(room);
  const winnerId = room.winner;
  const season = s.emptySeason(1000);
  const r1 = s.recordRoom(season, room, 5000);
  assert.strictEqual(r1.recorded, 2);
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(room.seasonRecorded, true);
  for (const sc of scores) {
    const pid = room.players.find(p => p.id === sc.playerId).pid;
    const row = season.players[pid];
    assert.strictEqual(row.games, 1);
    assert.strictEqual(row.wins, winnerId === sc.playerId ? 1 : 0);
    assert.strictEqual(row.totalScore, sc.total);
    assert.strictEqual(row.bestChain, sc.longestChain);
    assert.strictEqual(row.lastAt, room.endedAt);
  }
  // 同一房间再计一次：幂等，不重复累计
  const r2 = s.recordRoom(season, room, 6000);
  assert.strictEqual(r2.recorded, 0);
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(season.players[PID_A].games, 1);
});

test('未结束/空房间不计入；无 pid 的玩家跳过但房间照常标记', () => {
  const season = s.emptySeason();
  const playing = g.newRoom('X1', 'p0', '甲');
  g.addPlayer(playing, 'p0', '甲', PID_A);
  g.addPlayer(playing, 'p1', '乙', PID_B);
  assert.strictEqual(s.recordRoom(season, playing).changed, false);
  assert.ok(!playing.seasonRecorded);

  const room = playGame(['甲', '乙']);
  // 抹掉乙的 pid（模拟旧客户端）
  room.players[1].pid = null;
  room.seasonRecorded = false;
  const r = s.recordRoom(season, room);
  assert.strictEqual(r.recorded, 1);
  assert.strictEqual(season.players[PID_A].games, 1);
  assert.strictEqual(season.players[PID_B], undefined);
  assert.strictEqual(room.seasonRecorded, true);
});

test('跨房间聚合同一 pid：场次累加、平均得分、最高连锁取最大、昵称更新', () => {
  const season = s.emptySeason();
  const r1 = playGame(['甲', '乙']); s.recordRoom(season, r1);
  const r2 = playGame(['甲', '乙']); s.recordRoom(season, r2);
  const sa = season.players[PID_A];
  const sc1 = g.computeScores(r1).find(x => x.playerId === 'p0');
  const sc2 = g.computeScores(r2).find(x => x.playerId === 'p0');
  assert.strictEqual(sa.games, 2);
  assert.strictEqual(sa.totalScore, sc1.total + sc2.total);
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.avgScore, Math.round((sc1.total + sc2.total) / 2 * 10) / 10);
  assert.ok(prof.bestChain >= 1);
});

test('平局：人人算平、无人算负，胜率按胜场/场次', () => {
  const season = s.emptySeason();
  const room = playGame(['甲', '乙']);
  room.winner = null; // 强制并列
  room.seasonRecorded = false;
  s.recordRoom(season, room);
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.games, 1);
  assert.strictEqual(prof.wins, 0);
  assert.strictEqual(prof.ties, 1);
  assert.strictEqual(prof.losses, 0);
  assert.strictEqual(prof.winRate, 0);
});

test('排行榜：总分/胜场/胜率三种排序与名次，空赛季返回空表', () => {
  const season = s.emptySeason();
  // 手工造记录：A 总分高但只打 1 场；B 胜场多胜率稳；C 场次多
  season.players[PID_A] = { pid: PID_A, name: '阿强', games: 1, wins: 1, ties: 0, totalScore: 100, bestChain: 5, lastAt: 1 };
  season.players[PID_B] = { pid: PID_B, name: '阿花', games: 4, wins: 3, ties: 1, totalScore: 80, bestChain: 4, lastAt: 2 };
  season.players[PID_C] = { pid: PID_C, name: '阿伟', games: 10, wins: 2, ties: 0, totalScore: 60, bestChain: 3, lastAt: 3 };

  const byTotal = s.leaderboard(season, { sort: 'total' });
  assert.deepStrictEqual(byTotal.map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(byTotal.map(r => r.rank), [1, 2, 3]);

  const byWins = s.leaderboard(season, { sort: 'wins' });
  assert.deepStrictEqual(byWins.map(r => r.pid), [PID_B, PID_C, PID_A]);

  const byRate = s.leaderboard(season, { sort: 'rate' });
  assert.deepStrictEqual(byRate.map(r => r.pid), [PID_A, PID_B, PID_C]);
  // A 胜率 1.0（1/1），B 0.75（3/4），C 0.2
  assert.strictEqual(byRate[0].winRate, 1);
  assert.strictEqual(byRate[1].winRate, 0.75);

  // 非法/缺省排序回退总分
  assert.deepStrictEqual(s.leaderboard(season, { sort: 'hack' }).map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(s.leaderboard(season).map(r => r.pid), [PID_A, PID_B, PID_C]);
  assert.deepStrictEqual(s.leaderboard(s.emptySeason()), []);
});

test('排行榜行含派生字段：平均得分、胜率、负场', () => {
  const season = s.emptySeason();
  season.players[PID_B] = { pid: PID_B, name: '阿花', games: 4, wins: 3, ties: 1, totalScore: 80, bestChain: 4, lastAt: 2 };
  const row = s.leaderboard(season, { sort: 'wins' })[0];
  assert.strictEqual(row.avgScore, 20);
  assert.strictEqual(row.losses, 0);
  assert.strictEqual(row.winRate, 0.75);
});

test('个人页：无记录/非法 pid 返回 null；有记录附带总分榜名次', () => {
  assert.strictEqual(s.getProfile(s.emptySeason(), PID_A), null);
  assert.strictEqual(s.getProfile(s.emptySeason(), 'nope'), null);
  const season = s.emptySeason();
  season.players[PID_A] = { pid: PID_A, name: '阿强', games: 1, wins: 1, ties: 0, totalScore: 100, bestChain: 5, lastAt: 1 };
  const prof = s.getProfile(season, PID_A);
  assert.strictEqual(prof.rank, 1);
  assert.strictEqual(prof.name, '阿强');
});

test('normalizeSeason：补零缺字段、丢弃非法 pid/脏条目，保留有效记录', () => {
  const raw = {
    startedAt: 123,
    players: {
      [PID_A]: { pid: PID_A, name: '甲', games: 3, wins: 2, ties: 0, totalScore: 30, bestChain: 4, lastAt: 9 },
      badshort: { pid: 'badshort', name: '脏', games: 9 },
      [PID_B]: { name: '乙' }, // 字段全缺：补零，仍是有效 pid
    },
  };
  const season = s.normalizeSeason(raw);
  assert.strictEqual(season.startedAt, 123);
  assert.strictEqual(season.players[PID_A].games, 3);
  assert.strictEqual(season.players['badshort'], undefined);
  const b = season.players[PID_B];
  assert.strictEqual(b.games, 0);
  assert.strictEqual(b.name, '乙');
  // 损坏输入不抛错，得到空赛季
  assert.deepStrictEqual(s.normalizeSeason(null).players, {});
  assert.deepStrictEqual(s.normalizeSeason('x').players, {});
});
