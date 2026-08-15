/* =========================================================
 * 住哪儿 · Cloudflare Worker
 * 路由：
 *   /etd     驾车「未来路线规划」：按出发时刻的历史同时段路况预测时长
 *   /transit 公交路径规划：含分段步行明细（steps 距离），nightflag=0 排除夜班车
 *   /api/ai/assistant  AI 选房助手（DeepSeek + AI SDK streamText + Tool）
 *   其他路径          静态站点（wrangler assets，Vite 构建产物 dist/）
 *
 * AI 助手的事实来源：每次请求中前端快照 context.listings
 * （页面决策引擎已算出的排名/评分/通勤/硬约束），AI 只查询与解释，不参与计算。
 *
 * 密钥（都不出现在前端代码中）：
 *   npx wrangler secret put AMAP_WEB_KEY
 *   npx wrangler secret put DEEPSEEK_API_KEY
 * 本地调试：npm run dev（.dev.vars 中配置同名变量）
 * ========================================================= */

import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
} from 'ai';
import { z } from 'zod';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

async function forward(api) {
  try {
    const resp = await fetch(api.toString());
    const data = await resp.json();
    return json(data, resp.status);
  } catch (e) {
    return json({ errcode: -1, errmsg: '上游请求失败: ' + e.message }, 502);
  }
}

/* =========================================================
 * AI 选房助手
 * ========================================================= */

const MAX_LISTINGS = 5;   // 单次最多传 5 套房源
const MAX_MESSAGES = 20;  // 最多保留近 20 条历史消息
const MAX_STEPS = 5;      // AI 最多执行 5 步

/* ---- 请求体校验（zod）：消息数、房源数、字符串长度、数值范围 ---- */
const AmenitySchema = z.object({
  name: z.string().max(100),
  distKm: z.number().min(0).max(100),
  walkMin: z.number().min(0).max(600).optional(),
});

const ListingSchema = z.object({
  id: z.number().int(),
  letter: z.string().max(2).optional(),
  name: z.string().max(100),
  address: z.string().max(200),
  rent: z.number().min(0).max(1000000),
  area: z.number().min(0).max(10000).optional(),
  layout: z.string().max(50).optional(),
  floor: z.string().max(20).optional(),
  facing: z.string().max(20).optional(),
  rentType: z.string().max(20).optional(),
  note: z.string().max(500).optional(),
  rank: z.number().int().min(1).max(99).optional(),
  score: z.number().min(0).max(100).optional(),
  status: z.enum(['eligible', 'conditional', 'ineligible']).optional(),
  statusLabel: z.string().max(30).optional(),
  dimScores: z.record(z.string(), z.number().min(0).max(100)).optional(),
  monthlyCost: z.number().min(0).max(1000000).optional(),
  totalMonthlyCost: z.number().min(0).max(1000000).optional(),
  commute: z.object({
    mode: z.string().max(20),
    modeLabel: z.string().max(20),
    conservativeMinutes: z.number().min(0).max(600),
    durationMinutes: z.number().min(0).max(600).optional(),
    distanceKm: z.number().min(0).max(500).optional(),
    transfers: z.number().int().min(0).max(20).optional(),
    latestDeparture: z.string().max(10),
    unsuitable: z.boolean(),
  }).optional(),
  station: z.object({
    name: z.string().max(100),
    walkMeters: z.number().min(0).max(100000),
    walkMin: z.number().min(0).max(600),
  }).nullable().optional(),
  amenities: z.record(z.string().max(20), AmenitySchema).optional(),
  hardConstraintResults: z.array(z.object({
    label: z.string().max(50),
    result: z.string().max(20),
    detail: z.string().max(300),
  })).max(20).optional(),
  dataStatus: z.enum(['ok', 'pending_verification']).optional(),
});

const AssistantRequestSchema = z.object({
  messages: z.array(z.any()).min(1).max(MAX_MESSAGES * 2),
  context: z.object({
    company: z.string().max(200),
    budget: z.number().min(0).max(10000000),
    arriveTime: z.string().max(10),
    mode: z.string().max(20).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    dataFetchedAt: z.string().max(40).nullable().optional(),
    listings: z.array(ListingSchema).max(MAX_LISTINGS),
  }),
});

/* ---- Tool 输出用的房源摘要（含引用卡片所需关键字段） ---- */
function summary(l) {
  return {
    id: l.id,
    letter: l.letter || null,
    name: l.name,
    address: l.address,
    rank: l.rank ?? null,
    score: l.score ?? null,
    status: l.statusLabel || l.status || null,
    rent: l.rent,
    area: l.area ?? null,
    layout: l.layout ?? null,
    monthlyCost: l.monthlyCost ?? null,
    totalMonthlyCost: l.totalMonthlyCost ?? null,
    commute: l.commute ? {
      mode: l.commute.modeLabel,
      conservativeMinutes: l.commute.conservativeMinutes,
      latestDeparture: l.commute.latestDeparture,
      unsuitable: l.commute.unsuitable,
    } : null,
    station: l.station ?? null,
    dataStatus: l.dataStatus || 'ok',
  };
}

const AMENITY_KEYS = ['metro', 'hema', 'aldi', 'sam', 'rt', 'market', 'hospital', 'school', 'park'];
const AMENITY_LABEL = {
  metro: '地铁站', hema: '盒马鲜生', aldi: '奥乐齐', sam: '山姆会员店',
  rt: '大润发', market: '菜市场', hospital: '医院', school: '小学', park: '公园',
};

function amenityText(l) {
  return Object.entries(l.amenities || {})
    .map(([k, v]) => `${AMENITY_LABEL[k] || k}${v.name}${v.distKm}km`)
    .join(' ');
}

function buildTools(listings) {
  return {
    /* 模糊查找：名称/地址/通勤/配套/状态 关键词检索 */
    searchListings: tool({
      description: '在当前候选房源中按关键词模糊检索（名称、地址、户型、备注、通勤方式、周边配套、状态）。用于「地铁近」「医院方便」这类模糊需求。',
      inputSchema: z.object({
        keyword: z.string().max(50).describe('检索关键词，如「地铁」「医院」「盒马」'),
        limit: z.number().int().min(1).max(MAX_LISTINGS).default(MAX_LISTINGS).describe('最多返回条数'),
      }),
      execute: async ({ keyword, limit }) => {
        const kw = String(keyword).toLowerCase();
        const matched = listings.filter((l) => {
          const hay = [
            l.name, l.address, l.layout, l.note, l.statusLabel,
            l.commute?.modeLabel, l.station?.name, amenityText(l),
          ].filter(Boolean).join(' ').toLowerCase();
          return hay.includes(kw);
        }).slice(0, limit);
        return {
          keyword,
          total: matched.length,
          results: matched.map(summary), // 无结果时为空数组
        };
      },
    }),

    /* 自然语言筛选：预算 / 通勤 / 最晚出发 / 面积 / 配套 */
    filterListings: tool({
      description: '按硬性条件筛选当前候选房源：预算、月总成本、保守通勤分钟数、最晚出发时间、最小面积、周边配套距离、候选状态。返回符合项与被排除项及原因。',
      inputSchema: z.object({
        maxRent: z.number().min(0).optional().describe('月租金上限（元）'),
        maxTotalMonthlyCost: z.number().min(0).optional().describe('月总成本上限（元，含水电物业与通勤费）'),
        maxCommuteMinutes: z.number().min(0).max(600).optional().describe('保守通勤时间上限（分钟）'),
        earliestDeparture: z.string().regex(/^\d{1,2}:\d{2}$/).optional()
          .describe('不能早于该时刻出门，如 "07:30"（房源最晚出发时间须不早于它）'),
        minArea: z.number().min(0).optional().describe('最小面积（平米）'),
        amenity: z.enum(AMENITY_KEYS).optional().describe('要求附近具备的配套类型'),
        amenityMaxKm: z.number().min(0).max(50).optional().describe('配套距离上限（公里），与 amenity 搭配使用'),
        status: z.enum(['eligible', 'conditional', 'ineligible']).optional().describe('候选状态：eligible 推荐 / conditional 可考虑 / ineligible 不满足核心条件'),
      }),
      execute: async (cond) => {
        // 统一为零填充 HH:mm，保证字符串比较等价于时刻比较
        const norm = (t) => t.split(':').map((x) => x.padStart(2, '0')).join(':');
        const earliest = cond.earliestDeparture ? norm(cond.earliestDeparture) : null;
        const matched = [];
        const excluded = [];
        for (const l of listings) {
          const reasons = [];
          if (l.dataStatus === 'pending_verification' || !l.commute) {
            reasons.push('高德数据加载失败，未参与评分，数据待核验');
          } else {
            if (cond.maxRent != null && l.rent > cond.maxRent) reasons.push(`月租 ${l.rent} 元超出上限 ${cond.maxRent} 元`);
            if (cond.maxTotalMonthlyCost != null && l.totalMonthlyCost > cond.maxTotalMonthlyCost) reasons.push(`月总成本 ${l.totalMonthlyCost} 元超出上限 ${cond.maxTotalMonthlyCost} 元`);
            if (cond.maxCommuteMinutes != null && l.commute.conservativeMinutes > cond.maxCommuteMinutes) reasons.push(`保守通勤 ${l.commute.conservativeMinutes} 分钟超出上限 ${cond.maxCommuteMinutes} 分钟`);
            if (earliest && l.commute.latestDeparture < earliest) reasons.push(`最晚需 ${l.commute.latestDeparture} 出发，早于 ${earliest}`);
            if (cond.minArea != null && (l.area ?? 0) < cond.minArea) reasons.push(`面积 ${l.area} 平米小于 ${cond.minArea} 平米`);
            if (cond.amenity) {
              const a = (l.amenities || {})[cond.amenity];
              if (!a) reasons.push(`附近 5 公里内未找到${AMENITY_LABEL[cond.amenity]}`);
              else if (cond.amenityMaxKm != null && a.distKm > cond.amenityMaxKm) reasons.push(`最近${AMENITY_LABEL[cond.amenity]} ${a.distKm} 公里，超出 ${cond.amenityMaxKm} 公里`);
            }
            if (cond.status && l.status !== cond.status) reasons.push(`状态为「${l.statusLabel}」，不符合要求`);
          }
          (reasons.length ? excluded : matched).push(reasons.length ? { id: l.id, letter: l.letter || null, name: l.name, reasons } : summary(l));
        }
        return {
          conditions: cond,
          matched: matched.slice(0, MAX_LISTINGS),
          excluded: excluded.slice(0, MAX_LISTINGS),
        };
      },
    }),

    /* A/B 对比：成本、通勤、配套、底线差异 */
    compareListings: tool({
      description: '对比两套房源的成本、通勤、配套、硬约束与评分差异。用户问「A 和 B 怎么选 / 多花的钱换来什么」时使用。',
      inputSchema: z.object({
        idA: z.number().int().describe('第一套房源 id'),
        idB: z.number().int().describe('第二套房源 id'),
      }),
      execute: async ({ idA, idB }) => {
        const a = listings.find((l) => l.id === idA);
        const b = listings.find((l) => l.id === idB);
        if (!a || !b) {
          return { error: `未找到房源（可用：${listings.map((l) => `id=${l.id} ${l.name}`).join('，') || '无'}）`, a: a ? summary(a) : null, b: b ? summary(b) : null };
        }
        const poiKeys = [...new Set([...Object.keys(a.amenities || {}), ...Object.keys(b.amenities || {})])];
        const amenityDiff = {};
        poiKeys.forEach((k) => {
          amenityDiff[AMENITY_LABEL[k] || k] = {
            a: a.amenities?.[k] ? `${a.amenities[k].name} ${a.amenities[k].distKm}km` : '5km 内无',
            b: b.amenities?.[k] ? `${b.amenities[k].name} ${b.amenities[k].distKm}km` : '5km 内无',
          };
        });
        return {
          a: { ...summary(a), dimScores: a.dimScores, hardConstraintResults: a.hardConstraintResults },
          b: { ...summary(b), dimScores: b.dimScores, hardConstraintResults: b.hardConstraintResults },
          comparison: {
            rentDiff: a.rent - b.rent,
            totalMonthlyCostDiff: (a.totalMonthlyCost ?? 0) - (b.totalMonthlyCost ?? 0),
            commuteMinutesDiff: a.commute && b.commute ? a.commute.conservativeMinutes - b.commute.conservativeMinutes : null,
            amenities: amenityDiff,
          },
        };
      },
    }),

    /* 单套房源完整事实：支持追问与引用 */
    getListingById: tool({
      description: '按 id 获取单套房源的完整事实（档案、成本、通勤、地铁、配套、硬约束、评分）。用于对某套房源的追问。',
      inputSchema: z.object({
        id: z.number().int().describe('房源 id'),
      }),
      execute: async ({ id }) => {
        const l = listings.find((x) => x.id === id);
        return { listing: l || null }; // 不存在时为 null，模型必须说明未找到
      },
    }),
  };
}

function buildSystemPrompt(context) {
  const { company, budget, arriveTime, mode, weights, listings } = context;
  const index = listings.map((l) =>
    `- id=${l.id}：房源 ${l.letter || '?'}「${l.name}」（${l.dataStatus === 'pending_verification' ? '数据待核验，未参与评分' : `当前排名第 ${l.rank}，状态「${l.statusLabel}」`}）`
  ).join('\n') || '（当前页面没有已计算的房源）';
  const w = weights ? Object.entries(weights).map(([k, v]) => `${k} ${v}%`).join(' / ') : '';
  return `你是「住哪儿」结果页的 AI 选房助手。你只能基于用户当前页面已经计算出的真实房源数据回答问题。

【铁律】
1. 涉及任何房源事实（名称、租金、面积、通勤、配套、排名、评分、硬约束结果），必须先调用 Tool 获取，禁止凭系统提示中的索引以外的信息作答，禁止编造页面中不存在的房源或数据。
2. 禁止重新计算、修改或杜撰评分、排名、权重；页面计算结果是唯一事实来源，你只能查询和解释。
3. 每次回答最多引用 ${MAX_LISTINGS} 套房源；引用时使用「房源 A（名称）」格式。
4. Tool 返回空数组或 null 时，必须明确告知「当前候选中没有符合条件的房源」，并建议用户可以放宽哪个具体条件，禁止虚构房源。
5. 学区资格、采光、噪音、产权、租约合规等无法从页面数据确认的信息，只能提示用户线下核验，不得替用户下结论或做决定。
6. 每次回答需注明「基于当前页面计算结果」。
7. 用中文、分点、简洁回答（约 200 字内）；回答末尾附一句免责声明：以上仅为数据解释，不构成租房建议。

【当前页面状态】
排序模式：${mode || '标准推荐'}${w ? `（权重：${w}）` : ''}
公司：${company}；目标到达时间：${arriveTime}；用户预算：${budget} 元/月
候选房源索引（仅 id 与名称，具体事实必须调用 Tool）：
${index}`;
}

async function handleAssistant(request, env) {
  if (!env.DEEPSEEK_API_KEY) return json({ error: 'Worker 未配置 DEEPSEEK_API_KEY' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  const parsed = AssistantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: '请求体校验失败', issues: parsed.error.issues.slice(0, 5) }, 400);
  }
  const { messages, context } = parsed.data;

  const deepseek = createOpenAI({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: env.DEEPSEEK_API_KEY,
  });

  try {
    const result = streamText({
      model: deepseek('deepseek-chat'),
      instructions: buildSystemPrompt(context),
      messages: await convertToModelMessages(messages.slice(-MAX_MESSAGES)),
      tools: buildTools(context.listings),
      stopWhen: isStepCount(MAX_STEPS),
      temperature: 0.2,
    });
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  } catch (e) {
    console.error('[AI assistant] streamText 失败', e);
    return json({ error: 'AI 服务暂时不可用，请稍后重试' }, 502);
  }
}

/* =========================================================
 * 路由入口
 * ========================================================= */
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // AI 选房助手（同源调用，不需要高德 Key）
    if (url.pathname === '/api/ai/assistant') {
      if (request.method !== 'POST') return json({ error: '仅支持 POST' }, 405);
      return handleAssistant(request, env);
    }

    // 高德 Web服务代理
    if (url.pathname === '/etd' || url.pathname === '/transit') {
      if (!env.AMAP_WEB_KEY) return json({ errcode: -1, errmsg: 'Worker 未配置 AMAP_WEB_KEY' }, 500);

      const origin = url.searchParams.get('origin');           // "lng,lat"
      const destination = url.searchParams.get('destination'); // "lng,lat"
      if (!origin || !destination) {
        return json({ errcode: -1, errmsg: '缺少 origin / destination 参数' }, 400);
      }

      // 驾车未来路线规划（ETD）
      if (url.pathname === '/etd') {
        const firsttime = url.searchParams.get('firsttime');   // unix 秒，必须是未来时间
        if (!firsttime) return json({ errcode: -1, errmsg: '缺少 firsttime 参数' }, 400);
        const api = new URL('https://restapi.amap.com/v3/etd/driving');
        api.searchParams.set('key', env.AMAP_WEB_KEY);
        api.searchParams.set('origin', origin);
        api.searchParams.set('destination', destination);
        api.searchParams.set('strategy', '1');     // 躲避拥堵
        api.searchParams.set('firsttime', firsttime);
        api.searchParams.set('interval', '900');
        api.searchParams.set('count', '1');
        return forward(api);
      }

      // 公交路径规划（含分段步行明细；nightflag=0 不计算夜班车）
      const city = url.searchParams.get('city') || '上海';
      const api = new URL('https://restapi.amap.com/v3/direction/transit/integrated');
      api.searchParams.set('key', env.AMAP_WEB_KEY);
      api.searchParams.set('origin', origin);
      api.searchParams.set('destination', destination);
      api.searchParams.set('city', city);
      api.searchParams.set('cityd', city);
      api.searchParams.set('strategy', '0');     // 最快捷
      api.searchParams.set('nightflag', '0');    // 不计算夜班车
      api.searchParams.set('extensions', 'all'); // 返回完整分段（含步行 steps 与线路 polyline）
      return forward(api);
    }

    // 其他路径 → 静态站点（Vite 构建产物）
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ errcode: -1, errmsg: 'not found' }, 404);
  },
};
