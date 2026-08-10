/* =========================================================
 * 住哪儿 · 高德「未来路线规划」代理（Cloudflare Worker）
 * 作用：浏览器 → 本 Worker → 高德 Web服务 ETD 接口
 *   1. 解决浏览器直连 restapi.amap.com 的跨域限制
 *   2. Web服务 Key 存放在 Worker 密钥里，不出现在前端代码中
 *
 * 部署：
 *   npx wrangler secret put AMAP_WEB_KEY   # 粘贴你的 Web服务 Key
 *   npx wrangler deploy
 * 本地调试：
 *   npx wrangler dev   # 默认 http://localhost:8787/etd
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname !== '/etd') return json({ errcode: -1, errmsg: 'not found' }, 404);
    if (!env.AMAP_WEB_KEY) return json({ errcode: -1, errmsg: 'Worker 未配置 AMAP_WEB_KEY' }, 500);

    const origin = url.searchParams.get('origin');           // "lng,lat"
    const destination = url.searchParams.get('destination'); // "lng,lat"
    const firsttime = url.searchParams.get('firsttime');     // unix 秒，必须是未来时间
    if (!origin || !destination || !firsttime) {
      return json({ errcode: -1, errmsg: '缺少 origin / destination / firsttime 参数' }, 400);
    }

    // 高德驾车未来路线规划（ETD）：按出发时刻的历史同时段路况预测行程时长
    const api = new URL('https://restapi.amap.com/v3/etd/driving');
    api.searchParams.set('key', env.AMAP_WEB_KEY);
    api.searchParams.set('origin', origin);
    api.searchParams.set('destination', destination);
    api.searchParams.set('strategy', '1');       // 躲避拥堵
    api.searchParams.set('firsttime', firsttime);
    api.searchParams.set('interval', '900');
    api.searchParams.set('count', '1');

    try {
      const resp = await fetch(api.toString());
      const data = await resp.json();
      return json(data, resp.status);
    } catch (e) {
      return json({ errcode: -1, errmsg: '上游请求失败: ' + e.message }, 502);
    }
  },
};
