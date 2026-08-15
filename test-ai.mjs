// 本地端到端测试脚本：模拟 PRD 第 9 步的测试问题，验证 Tool 调用与防编造
// 用法：node test-ai.mjs [问题序号]
const ctx = {
  company: '上海中心大厦',
  budget: 8000,
  arriveTime: '09:00',
  mode: '标准推荐',
  weights: { commute: 35, cost: 25, life: 20, edu: 10, living: 10 },
  listings: [
    {
      id: 1, letter: 'A', name: '徐汇滨江一居室', address: '上海市徐汇区龙兰路 399 弄',
      rent: 7200, area: 52, layout: '1室1厅', rank: 2, score: 78,
      status: 'conditional', statusLabel: '可考虑',
      dimScores: { commute: 80, cost: 60, life: 85, edu: 70, living: 75 },
      monthlyCost: 7408, totalMonthlyCost: 7548,
      commute: { mode: 'transit', modeLabel: '地铁/公交', conservativeMinutes: 38, latestDeparture: '07:42', unsuitable: false },
      station: { name: '龙耀路站', walkMeters: 650, walkMin: 9 },
      amenities: { metro: { name: '龙耀路站', distKm: 0.7 }, hospital: { name: '徐汇区中心医院', distKm: 1.2 }, hema: { name: '盒马徐汇滨江店', distKm: 0.8 } },
      hardConstraintResults: [{ label: '预算', result: '满足', detail: '月总成本 7548 元 ≤ 8000 元' }],
      dataStatus: 'ok',
    },
    {
      id: 2, letter: 'B', name: '静安大宁两居室', address: '上海市静安区灵石路 718 号',
      rent: 8600, area: 78, layout: '2室2厅', rank: 3, score: 71,
      status: 'ineligible', statusLabel: '不满足核心条件',
      dimScores: { commute: 72, cost: 45, life: 88, edu: 80, living: 85 },
      monthlyCost: 8912, totalMonthlyCost: 9052,
      commute: { mode: 'transit', modeLabel: '地铁/公交', conservativeMinutes: 44, latestDeparture: '07:36', unsuitable: false },
      station: { name: '上海马戏城站', walkMeters: 480, walkMin: 7 },
      amenities: { metro: { name: '上海马戏城站', distKm: 0.5 }, hospital: { name: '第十人民医院', distKm: 0.9 }, park: { name: '大宁公园', distKm: 0.3 } },
      hardConstraintResults: [{ label: '预算', result: '不满足', detail: '月总成本 9052 元 > 8000 元' }],
      dataStatus: 'ok',
    },
    {
      id: 3, letter: 'C', name: '浦东三林一居室', address: '上海市浦东新区三林路 518 弄',
      rent: 5600, area: 48, layout: '1室1厅', rank: 1, score: 86,
      status: 'eligible', statusLabel: '推荐',
      dimScores: { commute: 75, cost: 90, life: 70, edu: 60, living: 68 },
      monthlyCost: 5792, totalMonthlyCost: 5880,
      commute: { mode: 'transit', modeLabel: '地铁/公交', conservativeMinutes: 46, latestDeparture: '07:34', unsuitable: false },
      station: { name: '三林站', walkMeters: 820, walkMin: 12 },
      amenities: { metro: { name: '三林站', distKm: 0.8 }, market: { name: '三林菜市场', distKm: 0.4 }, hospital: { name: '东方医院南院', distKm: 2.8 } },
      hardConstraintResults: [{ label: '预算', result: '满足', detail: '月总成本 5880 元 ≤ 8000 元' }],
      dataStatus: 'ok',
    },
  ],
};

const QUESTIONS = [
  '预算 7000 内且保守通勤不超过 45 分钟的有哪些？',          // 1 应触发 filterListings
  '我不能早于 7:30 出门，要排除哪些房源？',                    // 2 filterListings earliestDeparture
  '房源 A 和 B 比，多花的钱换来了什么？',                      // 3 compareListings
  '第一名为什么不是租金最低的？',                              // 4 filter/getById 解释排名
  '附近有南极基地的房源有哪些？',                              // 5 必须诚实返回未找到
  '如果医院必须 1 公里内方便，应该优先看哪套？',               // 6 filter amenity
];

const qi = (Number(process.argv[2]) || 1) - 1;
const text = QUESTIONS[qi];
console.log(`Q${qi + 1}: ${text}\n`);

const resp = await fetch('http://127.0.0.1:8787/api/ai/assistant', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text }] }],
    context: ctx,
  }),
});
console.log('HTTP', resp.status, resp.headers.get('content-type'));

const raw = await resp.text();
const toolsCalled = new Set();
let answer = '';
for (const line of raw.split('\n')) {
  if (!line.startsWith('data:')) continue;
  const data = line.slice(5).trim();
  if (data === '[DONE]') continue;
  try {
    const c = JSON.parse(data);
    if (c.type === 'tool-input-available') toolsCalled.add(c.toolName);
    if (c.type === 'text-delta') answer += c.delta;
  } catch { /* ignore */ }
}
console.log('Tools 调用:', [...toolsCalled].join(', ') || '（无）');
console.log('--- 回答 ---');
console.log(answer);

// 追问测试（多轮上下文）
if (qi === 0) {
  console.log('\n--- 追问：那第一套离地铁多远？ ---');
  const resp2 = await fetch('http://127.0.0.1:8787/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: answer }] },
        { id: 'm3', role: 'user', parts: [{ type: 'text', text: '那第一套离地铁多远？' }] },
      ],
      context: ctx,
    }),
  });
  const raw2 = await resp2.text();
  const tools2 = new Set();
  let answer2 = '';
  for (const line of raw2.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    try {
      const c = JSON.parse(data);
      if (c.type === 'tool-input-available') tools2.add(c.toolName);
      if (c.type === 'text-delta') answer2 += c.delta;
    } catch { /* ignore */ }
  }
  console.log('Tools 调用:', [...tools2].join(', ') || '（无）');
  console.log(answer2);
}
