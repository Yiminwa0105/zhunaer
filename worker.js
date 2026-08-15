/* =========================================================
 * 住哪儿 · 高德 Web服务代理（Cloudflare Worker）
 * 作用：浏览器 → 本 Worker → 高德 Web服务接口
 *   1. 解决浏览器直连 restapi.amap.com 的跨域限制
 *   2. Web服务 Key 存放在 Worker 密钥里，不出现在前端代码中
 *
 * 路由：
 *   /etd     驾车「未来路线规划」：按出发时刻的历史同时段路况预测时长
 *   /transit 公交路径规划：含分段步行明细（steps 距离），nightflag=0 排除夜班车
 *
 * 部署：
 *   npx wrangler secret put AMAP_WEB_KEY   # 粘贴你的 Web服务 Key
 *   npx wrangler deploy
 * 本地调试：
 *   npx wrangler dev   # 默认 http://localhost:8787/etd、/transit
 * ========================================================= */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
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
    if (url.pathname === '/transit') {
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

    return json({ errcode: -1, errmsg: 'not found' }, 404);
  },
};
