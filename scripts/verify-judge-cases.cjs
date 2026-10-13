#!/usr/bin/env node
/**
 * 判定样例集的**离线守卫**（进 build，不花调用）。
 *
 * 这套样例现在是那条判据的**主尺子**（真实会话无法标注），所以它自己不能坏：
 * 缺字段、id 重复、真值写成别的词、批次号断了，都会让"22/22 全对"这句读数失去意义。
 * 线上那一步（真跑模型）在 `npm run check:judge`，需要 3098 与 cookie。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'tools', 'probes', 'judge-cases.json');
const corpus = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const cases = corpus.cases ?? [];
const checks = [];
const ok = (name, cond, detail) => checks.push([name, cond, detail]);

ok('样例集非空', cases.length > 0, `${cases.length} 条`);
const ids = cases.map((c) => c.id);
ok('id 唯一', new Set(ids).size === ids.length);
ok('每条都有考点与四列材料', cases.every((c) =>
  typeof c.tests === 'string' && c.tests !== '' &&
  typeof c.node === 'string' && c.node !== '' &&
  typeof c.ask === 'string' && c.ask !== '' &&
  typeof c.objective === 'string' && c.objective !== '' &&
  typeof c.did === 'string' && c.did !== ''));
ok('标注只用「偏 / 不偏」', cases.every((c) =>
  (c.expect === undefined || c.expect === '偏' || c.expect === '不偏') &&
  (c.truth === undefined || c.truth === '偏' || c.truth === '不偏')));
const batches = [...new Set(cases.map((c) => c.batch ?? 1))].sort((a, b) => a - b);
ok('批次号从 1 起连续', batches.every((b, i) => b === i + 1), batches.join(','));
const withTruth = cases.filter((c) => c.truth !== undefined).length;
const positives = cases.filter((c) => (c.truth ?? c.expect) === '偏').length;
ok('真值与预标都齐（每条至少有预标）', cases.every((c) => c.truth !== undefined || c.expect !== undefined));
// 正负样本都要有：全是"偏"或全是"不偏"的样例集测不出误报/漏报
ok('正负样本都有', positives > 0 && positives < cases.length, `偏 ${positives} / 共 ${cases.length}`);

let bad = 0;
for (const [name, cond, detail] of checks) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) bad += 1;
}
console.log(`\n${checks.length - bad}/${checks.length} 项通过（人工真值 ${withTruth}/${cases.length} 条）`);
console.log('线上跑（需要 3098 + cookie）：npm run check:judge');
process.exit(bad === 0 ? 0 : 1);
