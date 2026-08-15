/* =========================================================
 * 住哪儿 · 标准推荐与个性化偏好决策系统
 * 模型：硬约束 + 可解释加权评分 + 通勤可靠性（保守通勤时间）
 * 数据：全部来自高德地图 JS API 实时查询（地理编码/路线规划/POI），
 *       无模拟数据；接口失败时明确报错，不用假数据冒充真实数据。
 * ========================================================= */

/* ---------- 维度与权重 ---------- */
const DIMS = [
  { key: 'commute', label: '通勤' },
  { key: 'cost',    label: '成本' },
  { key: 'life',    label: '生活便利' },
  { key: 'edu',     label: '教育资源' },
  { key: 'living',  label: '居住条件' },
];
const STD_WEIGHTS = { commute: 35, cost: 25, life: 20, edu: 10, living: 10 };

const COMMUTE_SUBS = [
  { key: 'late',     label: '最晚出发时间', def: 15 },
  { key: 'cons',     label: '保守通勤时间', def: 35 },
  { key: 'rel',      label: '通勤可靠性',   def: 20 },
  { key: 'metro',    label: '地铁优先',     def: 10 },
  { key: 'transfer', label: '少换乘',       def: 10 },
  { key: 'fee',      label: '交通费用',     def: 10 },
];
const LIFE_SUBS = [
  { key: 'metroNear', label: '最近地铁站',        def: 15 },
  { key: 'daily',     label: '盒马/奥乐齐/菜场',   def: 30 },
  { key: 'bigStore',  label: '山姆/大润发等商超',  def: 25 },
  { key: 'hospital',  label: '医院',              def: 20 },
  { key: 'park',      label: '公园和运动设施',     def: 10 },
];

/* ---------- 通勤时间口径定义 ----------
 * P50（常规路线通勤时间）= 从房源出发至公司地图终点，在指定交通方式、
 *   工作日、相近出发时段下的历史路线耗时中位数。P50 仅包含地图路线本身的耗时
 *   （步行接驳、等车、乘车、换乘或驾车路段），不包含进入园区、停车、安检、
 *   等电梯、走到工位和打卡时间。
 *   实现：opt.duration 直接取高德路线规划时长（公交含步行接驳/等车/换乘，
 *   驾车含实时路况），符合上述口径；ETD 开通后驾车 P50 为同时段历史预测值。
 * 保守通勤时间 = P50 + 方式波动缓冲 + 到楼/打卡缓冲（ARRIVAL_BUFFER） */
const ARRIVAL_BUFFER = 10;
const MODE_KIND = {
  metro_direct:   { buffer: 10, label: '地铁直达', rel: '稳定',     relScore: 95, fee: 5 },
  metro_transfer: { buffer: 15, label: '地铁换乘', rel: '稳定',     relScore: 85, fee: 5 },
  drive:          { buffer: 25, label: '驾车',     rel: '波动较大', relScore: 55, fee: 22 },
  bike:           { buffer: 10, label: '骑行',     rel: '一般',     relScore: 80, fee: 1.5 },
  walk:           { buffer: 5,  label: '步行',     rel: '稳定',     relScore: 90, fee: 0 },
};
const TRANSPORT_MODES = ['transit', 'drive', 'bike', 'walk'];
const TRANSPORT_LABEL = { transit: '地铁/公交', drive: '驾车', bike: '骑行', walk: '步行' };

/* ---------- 底线（硬约束）配置 ---------- */
const LEVELS = ['无所谓', '希望有', '很重要', '必须满足'];
const CONSTRAINTS = [
  { key: 'budget',         label: '月支出预算内',   type: 'budget', caps: [5000, 7000, 8000, 10000], dim: 'cost' },
  { key: 'maxCommute',     label: '保守通勤不超过', type: 'number', def: 45, unit: '分钟', caps: [30, 45, 60, 90], dim: 'commute' },
  { key: 'earliestDepart', label: '出发不早于',     type: 'time',   def: '07:00', dim: 'commute' },
  { key: 'minArea',        label: '面积不小于',     type: 'number', def: 40, unit: '㎡', caps: [30, 40, 50, 60], dim: 'living' },
  { key: 'metro',          label: '地铁可达（步行≤1.2km）', dim: 'commute' },
  { key: 'daily',          label: '附近有盒马/奥乐齐/菜场', dim: 'life' },
  { key: 'sam',            label: '附近有山姆',     dim: 'life' },
  { key: 'hospital',       label: '附近有医院',     dim: 'life' },
  { key: 'school',         label: '附近有学校',     dim: 'edu' },
  { key: 'wholeRent',      label: '必须整租',       dim: 'living' },
  { key: 'privateBath',    label: '必须独卫',       dim: 'living' },
];

/* ---------- 快捷偏好卡片（最多选 3 项） ---------- */
const PREFS = [
  { key: 'late',     icon: '⏰', label: '尽量晚出门',             sub: '不用为了上班牺牲清晨时间', w: { commute: 12, cost: -4, life: -4, edu: -2, living: -2 }, subC: { late: 25 } },
  { key: 'metro',    icon: '🛤', label: '地铁方便、少换乘',        sub: '更稳定，也更从容',          w: { commute: 10, life: 2, cost: -4, edu: -4, living: -4 }, subC: { metro: 20, transfer: 15 } },
  { key: 'stable',   icon: '🛡', label: '通勤稳定，不容易迟到',    sub: '给早高峰的意外留出缓冲',     w: { commute: 12, cost: -4, life: -4, edu: -2, living: -2 }, subC: { rel: 25, cons: 10 } },
  { key: 'cash',     icon: '💰', label: '每月现金支出低',          sub: '到手现金流更宽裕',          w: { cost: 15, commute: -5, life: -5, edu: -2, living: -3 } },
  { key: 'totalCost',icon: '📉', label: '综合月成本低',            sub: '把交通费用也算进来',        w: { cost: 12, commute: -2, life: -4, edu: -3, living: -3 }, subC: { fee: 15 } },
  { key: 'daily',    icon: '🛒', label: '附近有日常商超',          sub: '盒马、奥乐齐和菜场更近',     w: { life: 12, commute: -4, cost: -4, edu: -2, living: -2 }, subL: { daily: 25 } },
  { key: 'bigStore', icon: '🛍', label: '附近有山姆、大润发',      sub: '周末集中采购更方便',        w: { life: 12, commute: -4, cost: -4, edu: -2, living: -2 }, subL: { bigStore: 25 } },
  { key: 'hospital', icon: '🏥', label: '医院方便',               sub: '看病配药不折腾',            w: { life: 8, edu: 4, commute: -4, cost: -4, living: -4 }, subL: { hospital: 25 } },
  { key: 'edu',      icon: '🎓', label: '教育资源方便',            sub: '仅参考周边资源，不代表学区', w: { edu: 15, commute: -5, cost: -5, life: -3, living: -2 } },
  { key: 'area',     icon: '🏠', label: '面积更大',               sub: '住得舒展一些',              w: { living: 15, cost: -6, commute: -4, life: -3, edu: -2 } },
  { key: 'wholeRent',icon: '🔐', label: '整租、独立、隐私更好',    sub: '不需要迁就室友',            w: { living: 12, cost: -5, commute: -3, life: -2, edu: -2 } },
  { key: 'light',    icon: '☀️', label: '采光和舒适度更好',        sub: '朝向楼层都讲究',            w: { living: 12, cost: -5, commute: -3, life: -2, edu: -2 } },
];

const AMENITY_META = {
  metro: { label: '地铁站' }, hema: { label: '盒马' }, aldi: { label: '奥乐齐' },
  sam: { label: '山姆' }, rt: { label: '大润发' }, market: { label: '菜场' },
  hospital: { label: '医院' }, school: { label: '学校' }, park: { label: '公园' },
};
const LISTING_COLORS = ['#2E8B72', '#C9A66B', '#5B7FB8', '#8A6BB8', '#C26A8A'];

/* =========================================================
 * 高德真实地图 Provider（JS API 2.0）
 * 数据获取成功后写入统一的结构化数据，评分引擎无感知；
 * 必需数据失败时明确报错并标记房源，不使用任何模拟数据。
 * ========================================================= */
const USE_AMAP = typeof window.AMap !== 'undefined';
// 「未来路线规划」Worker 代理地址（Cloudflare Worker，见 worker.js）。
// 部署后填入，例如 'https://zhunaer-etd-proxy.你的账号.workers.dev/etd'；
// 本地调试填 'http://localhost:8787/etd'；留空则不启用，自动使用缓冲模型。
// 本地开发用 wrangler dev 的本地代理（workers.dev 域名在国内网络不可达，线上需绑自定义域名）
const FUTURE_ROUTE_API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8787/etd'
  : 'https://zhunaer-etd-proxy.yiminwa0105.workers.dev/etd';
// 公交详细分段查询（Web服务，经 Worker 代理）：含逐步步行距离明细 + nightflag=0 排除夜班车；
// 不可用时自动回退 JS API Transfer（只有方案级总步行距离）
const TRANSIT_API = FUTURE_ROUTE_API ? FUTURE_ROUTE_API.replace(/\/etd$/, '/transit') : '';
const POI_QUERIES = [
  ['metro', '地铁站'], ['hema', '盒马鲜生'], ['aldi', '奥乐齐'],
  ['sam', '山姆会员店'], ['rt', '大润发'], ['market', '菜市场'],
  ['hospital', '医院'], ['school', '小学'], ['park', '公园'],
];
let amapMap = null;
let amapOverlays = { routes: [], pins: [], company: null };

function amapGeocode(address) {
  return new Promise((resolve, reject) => {
    new AMap.Geocoder({ city: '全国' }).getLocation(address, (status, result) => {
      if (status === 'complete' && result.geocodes && result.geocodes.length) {
        const g = result.geocodes[0];
        const ac = g.addressComponent || {};
        const city = (ac.city && ac.city.length) ? ac.city : ac.province; // 直辖市 city 为空，取省份
        resolve({ lng: g.location.lng, lat: g.location.lat, city });
      } else reject(new Error('地址解析失败: ' + address));
    });
  });
}

/* 公交详细分段（Web服务，经 Worker 代理）：
 * 逐步拼接「步行 X 米 → 地铁X号线（N 站）→ 步行 X 米」，并解析 polyline 供地图绘制 */
async function amapTransitDetailed(from, to, city) {
  if (!TRANSIT_API) return null;
  try {
    const res = await fetch(`${TRANSIT_API}?origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&city=${encodeURIComponent(city || '上海')}`);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.status !== '1' || !d.route || !d.route.transits || !d.route.transits.length) return null;
    const p = d.route.transits[0];
    const parts = [], lines = [], rawNames = [], path = [];
    const addPolyline = (pl) => String(pl || '').split(';').forEach((pt) => {
      const [x, y] = pt.split(',').map(Number);
      if (x && y) path.push([x, y]);
    });
    (p.segments || []).forEach((seg) => {
      const walkD = Math.round(((seg.walking && seg.walking.steps) || [])
        .reduce((s, st) => s + Number(st.distance || 0), 0));
      if (walkD > 1) parts.push(`步行 ${walkD} 米`); // ≤1 米多为站内换乘，忽略
      ((seg.walking && seg.walking.steps) || []).forEach((st) => addPolyline(st.polyline));
      const bl = seg.bus && seg.bus.buslines && seg.bus.buslines[0];
      if (bl) {
        rawNames.push(String(bl.name));
        const name = String(bl.name).replace(/\(.*?\)/g, '');
        lines.push(name);
        const stops = bl.via_num !== undefined && bl.via_num !== '' ? Number(bl.via_num)
          : (bl.via_stops ? bl.via_stops.length : null);
        parts.push(`${name}${stops ? `（${stops} 站）` : ''}`);
        addPolyline(bl.polyline);
      }
    });
    const transfers = Math.max(0, lines.length - 1);
    return {
      duration: Math.round(Number(p.duration) / 60),
      distance: Math.round((Number(p.distance) / 1000) * 10) / 10,
      kind: transfers > 0 ? 'metro_transfer' : 'metro_direct',
      transfers,
      night: rawNames.some((n) => /夜/.test(n)), // nightflag=0 之外的兜底检测
      route: parts.length
        ? `${parts.join(' → ')}${transfers ? `，换乘 ${transfers} 次` : '，无需换乘'}`
        : `公交方案全程约 ${(Number(p.distance) / 1000).toFixed(1)} 公里`,
      path: path.length >= 2 ? path : null,
    };
  } catch (e) { return null; }
}

function amapRoute(from, to, mode, city) {
  return new Promise((resolve) => {
    const fail = () => resolve(null);
    try {
      const origin = [from.lng, from.lat], dest = [to.lng, to.lat];
      if (mode === 'transit') {
        // 优先 Web服务详细分段；不可用（本地 wrangler 未启动/线上代理不通）回退 JS API
        amapTransitDetailed(from, to, city).then((det) => {
          if (det) return resolve(det);
          if (TRANSIT_API) console.warn('[住哪儿] 公交详细分段代理不可用，已回退 JS API（无分段步行明细）。本地请先运行 npm run dev；线上需网络可达 workers.dev');
        new AMap.Transfer({ city }).search(origin, dest, (status, result) => {
          if (status !== 'complete' || !result.plans || !result.plans.length) return fail();
          const p = result.plans[0];
          const lines = [], path = [], rawNames = [], parts = [];
          (p.segments || []).forEach((seg) => {
            // 按段拼接接驳描述：步行 XX 米 → 地铁X号线（N 站）→ …
            // 步行距离多层兜底：segment.distance → steps 逐段求和（部分方案 distance 字段为空）
            const walkD = seg.walking
              ? Math.round(Number(seg.walking.distance)
                || ((seg.walking.steps || []).reduce((s, st) => s + Number(st.distance || 0), 0)))
              : 0;
            if (walkD > 0) parts.push(`步行 ${walkD} 米`);
            if (seg.transit && seg.transit.lines && seg.transit.lines.length) {
              const raw = String(seg.transit.lines[0].name);
              rawNames.push(raw);
              const name = raw.replace(/\(.*?\)/g, '');
              lines.push(name);
              const stops = seg.transit.via_num != null ? seg.transit.via_num
                : (seg.transit.via_stops ? seg.transit.via_stops.length : null);
              parts.push(`${name}${stops ? `（${stops} 站）` : ''}`);
            }
            const segPath = (seg.transit && seg.transit.path)
              || (seg.walking && seg.walking.path)
              || ((seg.walking && seg.walking.steps) || []).flatMap((s) => s.path || []);
            (segPath || []).forEach((pt) => path.push(pt));
          });
          // 分段均无步行明细但方案级有总步行距离时，补充说明
          if (lines.length && !parts.some((x) => x.indexOf('步行') === 0)) {
            const totalWalk = Math.round(Number(p.walking_distance || 0));
            if (totalWalk > 0) parts.push(`全程步行接驳约 ${totalWalk} 米`);
          }
          const transfers = Math.max(0, lines.length - 1);
          // 夜班线路检测：线路名含「夜」（夜宵线/夜班线）则不属于工作日早高峰通勤
          const night = rawNames.some((n) => /夜/.test(n));
          resolve({
            duration: Math.round(p.time / 60),
            distance: Math.round((p.distance / 1000) * 10) / 10,
            kind: transfers > 0 ? 'metro_transfer' : 'metro_direct',
            transfers, night,
            route: parts.length
              ? `${parts.join(' → ')}${transfers ? `，换乘 ${transfers} 次` : '，无需换乘'}`
              : `公交方案全程约 ${(p.distance / 1000).toFixed(1)} 公里`,
            path: path.length >= 2 ? path : null,
          });
        });
        }); // 结束 amapTransitDetailed(...).then 的回退分支
      } else {
        const Svc = { drive: AMap.Driving, walk: AMap.Walking, bike: AMap.Riding }[mode];
        new Svc().search(origin, dest, (status, result) => {
          if (status !== 'complete' || !result.routes || !result.routes.length) return fail();
          const r = result.routes[0];
          const path = [];
          // Driving/Walking: r.steps[].path；Riding: r.rides[] 本身即步骤数组（每步含 path）
          const steps = r.steps || r.rides || [];
          steps.forEach((s) => (s.path || []).forEach((pt) => path.push(pt)));
          resolve({
            duration: Math.round(r.time / 60),
            distance: Math.round((r.distance / 1000) * 10) / 10,
            kind: mode, transfers: 0,
            route: `${TRANSPORT_LABEL[mode]}全程约 ${(r.distance / 1000).toFixed(1)} 公里`,
            path: path.length >= 2 ? path : null,
          });
        });
      }
    } catch (e) { fail(); }
  });
}

function amapPoi(keyword, center) {
  return new Promise((resolve) => {
    try {
      new AMap.PlaceSearch({ pageSize: 1, pageIndex: 1 })
        .searchNearBy(keyword, [center.lng, center.lat], 5000, (status, result) => {
          if (status !== 'complete' || !result.poiList || !result.poiList.pois || !result.poiList.pois.length) return resolve(null);
          const p = result.poiList.pois[0];
          const d = Math.round((p.distance / 1000) * 10) / 10;
          resolve({ name: p.name, dist: d, walkMin: Math.max(2, Math.round(d * 13)), driveMin: Math.max(2, Math.round(2 + d * 2.2)) });
        });
    } catch (e) { resolve(null); }
  });
}

/* 未来路线规划：按出发时刻的历史同时段路况预测驾车时长（经 Worker 代理，失败自动回退） */
function nextDepartureTs(departMin) {
  const d = new Date();
  d.setHours(Math.floor(departMin / 60), ((departMin % 60) + 60) % 60, 0, 0);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1); // 必须是未来时间
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); // 取最近的工作日
  return Math.floor(d.getTime() / 1000);
}
async function amapFutureDrive(from, to, departTs) {
  if (!FUTURE_ROUTE_API) return null;
  try {
    const u = `${FUTURE_ROUTE_API}?origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&firsttime=${departTs}`;
    const data = await (await fetch(u)).json();
    // 兼容两种响应格式：{errcode:0, data:{time_infos}} 或 {status:'1', route:{time_infos}}
    const ok = data.errcode === 0 || data.status === '1';
    if (!ok) return null;
    const ti = (data.data && data.data.time_infos) || (data.route && data.route.time_infos);
    let els = ti && ti.elements;
    if (!els) return null;
    if (!Array.isArray(els)) els = [els];
    const dur = Number(els[0] && els[0].duration);
    return dur > 0 ? Math.round(dur / 60) : null;
  } catch (e) {
    console.warn('[住哪儿] 未来路线规划不可用，回退到缓冲模型', e);
    return null;
  }
}

/* 真实经纬度 → 虚拟坐标（供结果页 Hero 相对方位小地图使用） */
function lnglatToVirtual(g) {
  const c = state._companyGeo ? state._companyGeo.lnglat : g;
  const x = 660 + (g.lng - c.lng) * 5500 * Math.cos((c.lat * Math.PI) / 180);
  const y = 290 - (g.lat - c.lat) * 6400;
  return { x: clamp(Math.round(x), 40, 960), y: clamp(Math.round(y), 40, 600) };
}

/* 预取真实数据：公司/房源地理编码 → 4 种通勤 → 周边 POI。
 * 全部来自高德实时查询，无模拟数据：任何必需环节失败则标记该房源加载失败，
 * 由 UI 明确提示，不用假数据冒充。以「房源地址+公司地址」为缓存签名。 */
async function ensureRealData() {
  if (!USE_AMAP) {
    state.dataError = '高德地图加载失败（可能是网络或 Key 问题），请刷新重试';
    return false;
  }
  state.dataError = null;
  let fetchedAny = false; // 本次是否真的发起了新的高德查询（用于区分本地快照与实时数据）
  if (!state._companyGeo || state._companyGeo.addr !== state.company) {
    try {
      const g = await amapGeocode(state.company);
      state._companyGeo = { addr: state.company, lnglat: g };
      if (g.city) state._companyCity = g.city;
      fetchedAny = true;
    } catch (e) {
      state.dataError = `公司地址「${state.company}」解析失败，请在第 1 步填写更精确的地址（如「上海中心大厦」）`;
      return false;
    }
  }
  const company = state._companyGeo.lnglat;
  let failed = 0;
  for (const l of state.listings) {
    const sig = `${l.address}|${state.company}`;
    // 坏路径自动修复：旧版本保存的快照可能把路径点存成 [null,null] 或 [0,0]（渲染只能
    // 退化为直线）。检测到这种损坏时即使签名匹配也强制重查，恢复真实轨迹后重新保存快照
    const pathCorrupt = (p) => Array.isArray(p) && p.length >= 2 && !p.some(validRoutePoint);
    const hasBadPaths = l._paths && Object.values(l._paths).some(pathCorrupt);
    if (l._realSig === sig && !hasBadPaths) continue;
    if (hasBadPaths) l._realSig = null;
    fetchedAny = true;
    try {
      if (!l._geo || l._geo.addr !== l.address) {
        const g = await amapGeocode(l.address);
        l._geo = { addr: l.address, lnglat: g };
        l.lnglat = g;
        l.coord = lnglatToVirtual(g);
      }
      // 驾车/骑行/步行为必需数据，任一失败视为该房源加载失败；
      // 公交允许「查不到可信路线」（如夜间查询只返回夜班线），单独标记不纳入推荐
      const commute = {}, paths = {};
      for (const m of TRANSPORT_MODES) {
        const r = await amapRoute(l.lnglat, company, m, state._companyCity);
        if (!r) {
          if (m === 'transit') {
            commute.transit = { duration: 0, distance: 0, kind: 'metro_transfer', transfers: 0, route: '', invalid: 'failed', invalidReason: '公交/地铁路线查询失败，数据待查询，未纳入推荐' };
            continue;
          }
          throw new Error(`${TRANSPORT_LABEL[m]}路线规划失败`);
        }
        commute[m] = { duration: r.duration, distance: r.distance, kind: r.kind, transfers: r.transfers, route: r.route };
        paths[m] = r.path;
        // 规则三：夜班线路（夜宵/夜班/夜间）不属于工作日通勤，不参与 P50/P90 与推荐
        if (m === 'transit' && r.night) {
          commute.transit.invalid = 'night';
          commute.transit.invalidReason = '当前路线包含夜宵/夜间运营线路（查询时不在日间运营时段），不属于工作日早高峰通勤，已不纳入推荐。公交数据待查询：请在日间运营时段重新打开本页自动重查';
        }
      }
      // 规则五：公交合理性校验（不展示、不参与推荐与 P50，标记待核验）
      const t = commute.transit, d = commute.drive;
      if (!t.invalid && t.distance < 20 && t.duration > 120) {
        t.invalid = 'anomaly';
        t.invalidReason = `通勤距离 ${t.distance} 公里但公交路线需 ${t.duration} 分钟，路线异常，数据待核验，已不纳入推荐`;
      }
      if (!t.invalid && d && t.duration > d.duration * 4) {
        t.invalid = 'unverified';
        t.invalidReason = '公交路线时长超过驾车 4 倍，路线数据待核验，已不纳入推荐';
      }
      // 周边 POI：搜不到 = 5km 内确实没有（真实结果），不算失败
      const amenities = {};
      for (const [key, kw] of POI_QUERIES) {
        amenities[key] = await amapPoi(kw, l.lnglat);
      }
      l.station = amenities.metro
        ? { name: amenities.metro.name, walk: Math.round(amenities.metro.dist * 1000), walkMin: amenities.metro.walkMin }
        : { name: '5 公里内无地铁站', walk: 9999, walkMin: 99 };
      l.commute = commute;
      l._paths = paths;
      l.amenities = amenities;
      l._realSig = sig;
      l._failed = false;
    } catch (e) {
      l._failed = true;
      l._realSig = null;
      failed++;
      console.warn('[住哪儿] 房源真实数据获取失败', l.address, e);
    }
  }
  if (failed) state.dataError = `${failed} 套房源的真实数据加载失败，请检查地址是否精确，或稍后重试`;
  // 未来路线规划：用「到达时间 − 缓冲」倒推出发时刻，查询该时刻的同时段驾车时长。
  // 以「地址+公司+到达时间」为缓存签名，到达时间变化时自动重查，失败保持缓冲模型结果。
  if (FUTURE_ROUTE_API) {
    const futSigOf = (l) => `${l.address}|${state.company}|${state.arriveTime}`;
    for (const l of state.listings) {
      if (!l.lnglat || !l.commute || !l.commute.drive || l._futureSig === futSigOf(l)) continue;
      const departMin = parseTime(state.arriveTime) - modeConservative('drive', l.commute.drive);
      const fut = await amapFutureDrive(l.lnglat, company, nextDepartureTs(departMin));
      if (fut) {
        l.commute.drive.duration = fut;
        l.commute.drive.route = l.commute.drive.route.replace(/（按 .*? 出发的同时段路况预测）/, '')
          + `（按 ${fmtTime(departMin)} 出发的同时段路况预测）`;
        l._futureSig = futSigOf(l);
      }
    }
  }
  if (fetchedAny) {
    state.dataFetchedAt = new Date().toISOString();
    state._freshFetch = true;
  }
  state.usingReal = true;
  return true;
}

function initAmapMap() {
  if (amapMap || !USE_AMAP) return;
  $('#amapContainer').classList.remove('hidden');
  amapMap = new AMap.Map('amapContainer', {
    viewMode: '2D', zoom: 11, center: [121.4998, 31.2397],
    mapStyle: 'amap://styles/darkblue',
  });
}

function renderRealMap() {
  if (!amapMap || !state._companyGeo) return;
  const company = state._companyGeo.lnglat;
  amapOverlays.routes.forEach((o) => amapMap.remove(o));
  amapOverlays.pins.forEach((o) => amapMap.remove(o.pin));
  if (amapOverlays.company) amapMap.remove(amapOverlays.company);
  amapOverlays = { routes: [], pins: [], company: null };

  state.listings.forEach((l, i) => {
    if (!l.lnglat) return;
    const color = LISTING_COLORS[i % LISTING_COLORS.length];
    const sel = l.id === state.selectedId;
    // 路线：只画选中房源的路线（点击图钉切换）。无效路线（夜班/异常）也画轨迹，
    // 但信息卡会说明不推荐原因；路线数据缺失或含坏点（历史快照可能存过 [null,null]）时
    // 过滤坏点后退化为房源—公司直线，保证始终有线且不中断其余标记渲染
    if (sel) {
      const raw = (l._paths && l._paths[state.mapMode]) || [];
      const cleanPath = raw
        .map((p) => (Array.isArray(p) ? p : [p.lng, p.lat]))
        .filter(validRoutePoint);
      const path = cleanPath.length >= 2
        ? cleanPath
        : [[l.lnglat.lng, l.lnglat.lat], [company.lng, company.lat]];
      const line = new AMap.Polyline({
        path, strokeColor: color, strokeWeight: 6, strokeOpacity: 0.95,
        strokeStyle: (state.mapMode === 'bike' || state.mapMode === 'walk') ? 'dashed' : 'solid',
        lineJoin: 'round', lineCap: 'round', zIndex: 60,
      });
      amapMap.add(line);
      amapOverlays.routes.push(line);
    }

    const pin = new AMap.Marker({
      position: [l.lnglat.lng, l.lnglat.lat],
      content: `<div class="amap-pin ${sel ? 'sel' : ''}" style="background:${color}">${String.fromCharCode(65 + i)}</div>`,
      offset: new AMap.Pixel(sel ? -18 : -15, sel ? -18 : -15),
      zIndex: sel ? 120 : 100, cursor: 'pointer',
    });
    pin.on('click', () => {
      state.selectedId = l.id;
      renderListingCards(); renderMap(); mapFocusSelected();
    });
    amapMap.add(pin);
    amapOverlays.pins.push({ id: l.id, pin });
  });

  amapOverlays.company = new AMap.Marker({
    position: [company.lng, company.lat],
    content: '<div class="amap-company">司</div>',
    offset: new AMap.Pixel(-16, -16), zIndex: 110,
  });
  amapMap.add(amapOverlays.company);

  renderMapInfo();
  document.querySelectorAll('#mapModes .map-mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mm === state.mapMode);
  });
}

function setMapLoading(on) {
  const el = $('#mapLoading');
  if (el) el.classList.toggle('hidden', !on);
}
function updateDataBadge() {
  const badge = document.querySelector('.demo-badge');
  if (badge) {
    // 本地保存的路线/POI 快照不能标记为「实时数据」：未重新查询时明确显示快照时间
    badge.textContent = state.dataError ? '真实数据不可用'
      : state._freshFetch ? '高德真实数据'
      : state.dataFetchedAt ? `本地快照 · 查询于 ${fmtDateTime(state.dataFetchedAt)}`
      : '真实数据加载中…';
  }
  const tag = document.querySelector('.map-tag');
  if (tag) tag.textContent = '真实地图 · 高德地图 JS API';
}
/* 数据状态提示：真实数据加载失败时明确报错（无模拟数据兜底） */
function renderDataState() {
  const el = $('#dataError');
  if (el) {
    el.classList.toggle('hidden', !state.dataError);
    el.textContent = state.dataError || '';
  }
  updateDataBadge();
}

/* ---------- 预置示例房源（仅房源档案信息；通勤/坐标/配套全部由高德实时查询填充） ---------- */
function seedListings() {
  return [
    {
      id: 1, name: '徐汇滨江一居室', address: '上海市徐汇区龙兰路 399 弄',
      rent: 7200, area: 52, layout: '1室1厅', floor: '12/18层', facing: '南',
      rentType: '整租', bath: '独卫', note: '近滨江步道，小区较新',
    },
    {
      id: 2, name: '静安大宁两居室', address: '上海市静安区灵石路 718 号',
      rent: 8600, area: 78, layout: '2室2厅', floor: '6/11层', facing: '南北',
      rentType: '整租', bath: '独卫', note: '近大宁公园，适合家庭',
    },
    {
      id: 3, name: '浦东三林一居室', address: '上海市浦东新区三林路 518 弄',
      rent: 5600, area: 48, layout: '1室1厅', floor: '3/6层', facing: '东南',
      rentType: '整租', bath: '独卫', note: '租金低，离前滩近',
    },
  ];
}

/* ---------- 全局状态 ---------- */
const state = {
  view: 'welcome',
  company: '上海中心大厦',
  arriveTime: '09:00',
  budget: 8000,
  prefTransport: 'mix',
  listings: seedListings(),
  nextId: 4,
  mode: 'standard',
  selectedPrefs: [],
  customTopWeights: null,
  commuteSub: Object.fromEntries(COMMUTE_SUBS.map((s) => [s.key, s.def])),
  lifeSub: Object.fromEntries(LIFE_SUBS.map((s) => [s.key, s.def])),
  constraints: Object.fromEntries(CONSTRAINTS.map((c) => [c.key, { lv: 0, val: c.def }])),
  computed: [],
  stdRanks: {}, personalRanks: {},
  weights: { ...STD_WEIGHTS },
  selectedId: 1,               // 地图选中房源
  mapMode: 'transit',          // 地图当前交通方式
  collapsed: {},
  usingReal: false,            // 是否已切换到高德真实数据
  dataError: null,             // 真实数据加载失败原因（无模拟兜底，失败必须明示）
  _companyGeo: null,           // 公司地理编码缓存 { addr, lnglat }
  _companyCity: '上海',
  dataFetchedAt: null,         // 路线/POI 快照查询时间（ISO 字符串）
  reportSnapshot: null,        // 最近一次选房报告快照
  _freshFetch: false,          // 本次会话是否真正重新查询过路线/POI（区分本地快照与实时数据）
};

/* =========================================================
 * 本地方案存储（localStorage，仅当前浏览器与设备，不上传、不同步）
 * 清除浏览器数据、无痕模式或换设备后方案可能丢失，UI 中已明确提示。
 * ========================================================= */
const PROJECT_KEY = 'zhunaer.projects.v1';
const LAST_OPEN_KEY = 'zhunaer.lastOpened.v1';
const PRIVACY_SHOWN_KEY = 'zhunaer.privacyShown.v1';
const PROJECT_VERSION = 1;
const STALE_MS = 24 * 3600 * 1000; // 路线/POI 快照超过 24 小时视为过期

let currentProjectId = null;
let currentProjectTitle = '未命名选房方案';
let projectCreatedAt = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_KEY)) || {};
  } catch (e) {
    console.warn('[住哪儿] 本地方案读取失败', e);
    return {};
  }
}
function writeProjects(projects) {
  localStorage.setItem(PROJECT_KEY, JSON.stringify(projects));
}

/* 合理轨迹点：数值有限且不落在 (0,0) 附近（坏点经 NaN→null→0 链路会变成 [0,0]） */
const validRoutePoint = (q) => !!q && Number.isFinite(q[0]) && Number.isFinite(q[1])
  && (Math.abs(q[0]) > 1 || Math.abs(q[1]) > 1);

/* 折线路径压缩：限制点数并转为 [lng, lat] 纯数组，控制存储体积、保证可序列化。
 * 兼容两种点格式：JS API 的 LngLat 对象（p.lng/p.lat）与 Web 服务代理的数组（p[0]/p[1]）；
 * 无效点（NaN/null/[0,0]）直接剔除，全部无效则返回 null（渲染退化为直线并由重查自愈） */
function trimPath(path) {
  if (!path || !path.length) return null;
  const toPair = (p) => {
    const pt = [Array.isArray(p) ? p[0] : p.lng, Array.isArray(p) ? p[1] : p.lat];
    return validRoutePoint(pt) ? [Math.round(pt[0] * 1e6) / 1e6, Math.round(pt[1] * 1e6) / 1e6] : null;
  };
  const pts = path.map(toPair).filter(Boolean);
  if (pts.length < 2) return null;
  if (pts.length <= 200) return pts;
  const step = Math.ceil(pts.length / 200);
  const out = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}

function serializeListing(l) {
  const out = {
    id: l.id, name: l.name, address: l.address, rent: l.rent, area: l.area,
    layout: l.layout, floor: l.floor, facing: l.facing,
    rentType: l.rentType, bath: l.bath, note: l.note,
    lnglat: l.lnglat || null, coord: l.coord || null,
    station: l.station || null, commute: l.commute || null, amenities: l.amenities || null,
    _realSig: l._realSig || null, _failed: !!l._failed, _futureSig: l._futureSig || null,
  };
  if (l._paths) {
    out._paths = {};
    Object.entries(l._paths).forEach(([m, p]) => { out._paths[m] = trimPath(p); });
  }
  return out;
}

/* 当前界面状态 → 方案数据结构（含 PRD 要求的摘要字段 + 完整 appState 用于无损恢复） */
function serializeProject() {
  const now = new Date().toISOString();
  const w = state.weights;
  const c = state.constraints;
  return {
    id: currentProjectId,
    title: currentProjectTitle,
    createdAt: projectCreatedAt || now,
    updatedAt: now,
    lastOpenedAt: now,
    version: PROJECT_VERSION,
    workplace: {
      address: state.company,
      location: state._companyGeo ? { lng: state._companyGeo.lnglat.lng, lat: state._companyGeo.lnglat.lat } : undefined,
      targetArrivalTime: state.arriveTime,
      earliestAcceptableDeparture: c.earliestDepart.lv > 0 ? c.earliestDepart.val : '06:30',
      workDaysPerMonth: 22,
      preferredModes: state.prefTransport === 'mix' ? [] : [state.prefTransport],
    },
    constraints: {
      monthlyBudget: state.budget,
      maxReliableCommuteMinutes: c.maxCommute.lv > 0 ? c.maxCommute.val : SYS_MAX_CONS,
      minArea: c.minArea.lv > 0 ? c.minArea.val : undefined,
      mustBeWholeRental: c.wholeRent.lv === 3,
      requiredAmenities: CONSTRAINTS.filter((x) => c[x.key].lv === 3 && !['budget', 'maxCommute', 'earliestDepart', 'minArea', 'wholeRent'].includes(x.key)).map((x) => x.key),
    },
    preferences: {
      scoringMode: state.mode === 'standard' ? 'standard' : 'custom',
      selectedPriorityCards: [...state.selectedPrefs],
      weights: { commute: w.commute, cost: w.cost, amenities: w.life, education: w.edu, housing: w.living },
    },
    listings: state.listings.map(serializeListing),
    reportSnapshot: state.reportSnapshot || undefined,
    routeSnapshots: state.dataFetchedAt ? [{ source: 'amap-jsapi', fetchedAt: state.dataFetchedAt }] : undefined,
    poiSnapshots: state.dataFetchedAt ? [{ source: 'amap-placesearch', fetchedAt: state.dataFetchedAt }] : undefined,
    dataFetchedAt: state.dataFetchedAt || null,
    appState: {
      company: state.company, arriveTime: state.arriveTime, budget: state.budget,
      prefTransport: state.prefTransport, nextId: state.nextId, mode: state.mode,
      selectedPrefs: [...state.selectedPrefs],
      customTopWeights: state.customTopWeights ? { ...state.customTopWeights } : null,
      commuteSub: { ...state.commuteSub }, lifeSub: { ...state.lifeSub },
      constraints: deepClone(state.constraints),
      selectedId: state.selectedId, mapMode: state.mapMode,
      usingReal: state.usingReal, _companyGeo: state._companyGeo, _companyCity: state._companyCity,
    },
  };
}

/* 方案数据 → 恢复界面状态 */
function applyProject(p) {
  const a = p.appState || {};
  currentProjectId = p.id;
  currentProjectTitle = p.title || '未命名选房方案';
  projectCreatedAt = p.createdAt || new Date().toISOString();

  state.company = a.company || (p.workplace && p.workplace.address) || '';
  state.arriveTime = a.arriveTime || '09:00';
  state.budget = a.budget != null ? a.budget : 8000;
  state.prefTransport = a.prefTransport || 'mix';
  state.listings = (p.listings || []).map((l) => ({ ...l }));
  state.nextId = a.nextId || (state.listings.reduce((m, l) => Math.max(m, l.id), 0) + 1);
  state.mode = a.mode || 'standard';
  state.selectedPrefs = a.selectedPrefs || [];
  state.customTopWeights = a.customTopWeights || null;
  state.commuteSub = a.commuteSub || Object.fromEntries(COMMUTE_SUBS.map((s) => [s.key, s.def]));
  state.lifeSub = a.lifeSub || Object.fromEntries(LIFE_SUBS.map((s) => [s.key, s.def]));
  state.constraints = a.constraints || Object.fromEntries(CONSTRAINTS.map((x) => [x.key, { lv: 0, val: x.def }]));
  state.selectedId = state.listings.some((l) => l.id === a.selectedId) ? a.selectedId : (state.listings[0] ? state.listings[0].id : null);
  state.mapMode = a.mapMode || 'transit';
  state.collapsed = {};
  state.usingReal = !!a.usingReal;
  state.dataError = null;
  state._companyGeo = a._companyGeo || null;
  state._companyCity = a._companyCity || '上海';
  state.dataFetchedAt = p.dataFetchedAt || null;
  state.reportSnapshot = p.reportSnapshot || null;
  state._freshFetch = false; // 恢复的是本地快照，需重新查询后才能标记为实时数据
  state.computed = [];
}

/* ---------- 保存状态指示（小型文字，不用弹窗） ---------- */
let saveTimer = null;
function setSaveStatus(kind) {
  const el = $('#saveStatus');
  if (!el) return;
  if (kind === 'saving') { el.className = 'save-status saving'; el.textContent = '正在保存…'; el.title = ''; }
  else if (kind === 'saved') { el.className = 'save-status saved'; el.textContent = '✓ 已保存到本设备'; el.title = '仅保存在当前浏览器，不会上传'; }
  else if (kind === 'error') { el.className = 'save-status error'; el.textContent = '保存失败，请重试'; el.title = '点击重试'; }
}

function saveNow() {
  if (!currentProjectId) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  setSaveStatus('saving');
  try {
    const projects = loadProjects();
    projects[currentProjectId] = serializeProject();
    writeProjects(projects);
    localStorage.setItem(LAST_OPEN_KEY, currentProjectId);
    setSaveStatus('saved');
    // 首次保存时提示隐私与限制（仅一次，不反复打扰）
    if (!localStorage.getItem(PRIVACY_SHOWN_KEY)) {
      localStorage.setItem(PRIVACY_SHOWN_KEY, '1');
      showNotice('已保存到本设备。你的方案仅保存在当前浏览器，不会上传；清除浏览器数据或更换设备后可能丢失，建议定期导出备份。');
    }
  } catch (e) {
    console.warn('[住哪儿] 保存失败', e);
    setSaveStatus('error');
  }
}
/* 停止输入 650ms 后保存；连续修改合并为一次写入 */
function scheduleSave() {
  if (!currentProjectId) return;
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 650);
}

/* ---------- 一次性通知条（恢复提示 / 过期数据提醒，非频繁 Toast） ---------- */
function showNotice(html, action) {
  document.querySelectorAll('.app-notice').forEach((n) => n.remove());
  const bar = document.createElement('div');
  bar.className = 'app-notice';
  bar.innerHTML = `<span class="an-text">${html}</span>
    ${action ? `<button class="an-action">${action.label}</button>` : ''}
    <button class="an-close">×</button>`;
  document.body.appendChild(bar);
  if (action) bar.querySelector('.an-action').addEventListener('click', () => { action.fn(); bar.remove(); });
  bar.querySelector('.an-close').addEventListener('click', () => bar.remove());
  if (!action) setTimeout(() => bar.remove(), 6000);
}

/* 路线/POI 快照过期提醒（> 24 小时） */
function checkStaleSnapshot() {
  if (!state.dataFetchedAt) return;
  const ageMs = Date.now() - new Date(state.dataFetchedAt).getTime();
  if (ageMs <= STALE_MS) return;
  const days = Math.max(1, Math.round(ageMs / STALE_MS));
  showNotice(
    `你正在查看保存于 ${days} 天前的方案。路线与周边数据可能已变化，建议重新查询。`,
    { label: '重新查询路线与周边数据', fn: refetchRealData }
  );
}
function refetchRealData() {
  // 使本地快照缓存失效，重新走高德实时查询
  state._companyGeo = null;
  state.listings.forEach((l) => { l._realSig = null; l._futureSig = null; l._failed = false; });
  if (state.view !== 'step2') { showView('step2'); return; }
  setMapLoading(true);
  ensureRealData().then(() => {
    setMapLoading(false);
    computeAll(); renderListingCards(); renderMap(); mapFitAll(); renderDataState();
    scheduleSave();
  });
}

/* ---------- 表单与状态同步（切换/恢复方案后调用） ---------- */
function syncInputsFromState() {
  $('#companyInput').value = state.company;
  $('#arriveTime').value = state.arriveTime;
  document.querySelectorAll('#prefTransportCaps .capsule').forEach((b) => {
    b.classList.toggle('active', b.dataset.pt === state.prefTransport);
  });
  renderConstraints();
  updateDataBadge();
}

function openProject(id) {
  const projects = loadProjects();
  const p = projects[id];
  if (!p) return;
  if (id !== currentProjectId) saveNow(); // 先保存当前方案
  applyProject(p);
  p.lastOpenedAt = new Date().toISOString();
  projects[id] = p;
  writeProjects(projects);
  localStorage.setItem(LAST_OPEN_KEY, id);
  syncInputsFromState();
  closeDrawer();
  showView(state.view === 'welcome' ? 'welcome' : state.view);
  setSaveStatus('saved');
  checkStaleSnapshot();
}

/* ---------- 新建 / 复制 / 重命名 / 删除 ---------- */
function resetToBlankProject(title) {
  currentProjectId = uid();
  currentProjectTitle = title || '未命名选房方案';
  projectCreatedAt = new Date().toISOString();
  state.company = '';
  state.arriveTime = '09:00';
  state.budget = 8000;
  state.prefTransport = 'mix';
  state.listings = [];
  state.nextId = 1;
  state.mode = 'standard';
  state.selectedPrefs = [];
  state.customTopWeights = null;
  state.commuteSub = Object.fromEntries(COMMUTE_SUBS.map((s) => [s.key, s.def]));
  state.lifeSub = Object.fromEntries(LIFE_SUBS.map((s) => [s.key, s.def]));
  state.constraints = Object.fromEntries(CONSTRAINTS.map((c) => [c.key, { lv: 0, val: c.def }]));
  state.computed = [];
  state.selectedId = null;
  state.collapsed = {};
  state.usingReal = false;
  state.dataError = null;
  state._companyGeo = null;
  state.dataFetchedAt = null;
  state.reportSnapshot = null;
  state._freshFetch = false;
}

function createProject() {
  saveNow();
  resetToBlankProject();
  saveNow();
  syncInputsFromState();
  closeDrawer();
  showView('step1'); // 引导进入第 1 步
}

function duplicateProject(id) {
  const projects = loadProjects();
  const src = projects[id];
  if (!src) return;
  const copy = deepClone(src);
  copy.id = uid();
  copy.title = `${src.title}（副本）`;
  copy.createdAt = copy.updatedAt = copy.lastOpenedAt = new Date().toISOString();
  projects[copy.id] = copy;
  writeProjects(projects);
  renderProjectList();
}

function renameProject(id) {
  const projects = loadProjects();
  const p = projects[id];
  if (!p) return;
  openModal(`
    <h4>重命名方案</h4>
    <input type="text" id="renameInput" maxlength="50" value="${p.title.replace(/"/g, '&quot;')}" placeholder="1–50 个字符">
    <div class="modal-err hidden" id="renameErr">名称不能为空</div>
    <div class="modal-btns">
      <button class="btn-back" id="modalCancel">取消</button>
      <button class="btn-next" id="modalOk">保存</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalOk').addEventListener('click', () => {
    const v = $('#renameInput').value.trim();
    if (!v) { $('#renameErr').classList.remove('hidden'); return; }
    p.title = v.slice(0, 50);
    p.updatedAt = new Date().toISOString();
    projects[id] = p;
    writeProjects(projects);
    if (id === currentProjectId) currentProjectTitle = p.title;
    closeModal();
    renderProjectList();
  });
}

function deleteProject(id) {
  const projects = loadProjects();
  const p = projects[id];
  if (!p) return;
  openModal(`
    <h4>确定删除「${p.title}」吗？</h4>
    <p class="modal-sub">删除后无法恢复，除非你此前已导出备份文件。</p>
    <div class="modal-btns">
      <button class="btn-back" id="modalCancel">取消</button>
      <button class="btn-danger" id="modalOk">确认删除</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalOk').addEventListener('click', () => {
    delete projects[id];
    writeProjects(projects);
    closeModal();
    if (id === currentProjectId) {
      localStorage.removeItem(LAST_OPEN_KEY);
      const rest = Object.values(projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (rest.length) {
        openProject(rest[0].id);
        return;
      }
      // 删除的是最后一个方案：回到欢迎页并创建新的默认空白方案
      resetToBlankProject();
      saveNow();
      syncInputsFromState();
      showView('welcome');
    }
    renderProjectList();
  });
}

/* ---------- 导出 / 导入备份 ---------- */
function exportProject(id) {
  if (id === currentProjectId) saveNow(); // 先落盘最新内容
  const p = loadProjects()[id];
  if (!p) return;
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `住哪儿-${p.title}-${p.updatedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function validateImport(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '文件格式不正确：不是有效的方案文件';
  if (p.version == null) return '文件格式不正确：缺少数据版本号';
  if (p.version > PROJECT_VERSION) return `版本暂不支持：文件版本为 v${p.version}，当前支持 v${PROJECT_VERSION}`;
  if (!p.workplace || typeof p.workplace.address !== 'string') return '文件格式不正确：缺少公司地址信息';
  if (!Array.isArray(p.listings)) return '文件格式不正确：缺少房源列表';
  if (!p.appState || typeof p.appState !== 'object') return '文件格式不正确：缺少界面状态数据';
  return null;
}

function importProjectFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let p;
    try {
      p = JSON.parse(reader.result);
    } catch (e) {
      showNotice('导入失败：文件格式不正确，请选择「住哪儿」导出的 JSON 备份文件。');
      return;
    }
    const err = validateImport(p);
    if (err) { showNotice(`导入失败：${err}。`); return; }
    // 导入为一个独立的新方案，不覆盖已有方案
    p.id = uid();
    if (!p.title) p.title = '未命名选房方案';
    p.updatedAt = new Date().toISOString();
    const projects = loadProjects();
    projects[p.id] = p;
    writeProjects(projects);
    renderProjectList();
    showNotice(`已导入为新方案「${p.title}」，不会影响已有方案。`);
  };
  reader.readAsText(file);
}

/* ---------- 我的方案抽屉 ---------- */
function fmtRelativeTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diffDays <= 0) return `今天 ${hm}`;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays < 30) return `${diffDays} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderProjectList() {
  const wrap = $('#pdList');
  const projects = Object.values(loadProjects()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!projects.length) {
    wrap.innerHTML = `
      <div class="pd-empty">
        <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M54 50a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4h14l6 8h16a4 4 0 0 1 4 4z"/>
          <path d="M24 34h16M24 42h10" opacity=".5"/>
        </svg>
        <p>你还没有保存任何选房方案。<br>从第一套候选房源开始吧。</p>
        <button class="btn-next" id="pdEmptyNew">＋ 新建选房方案</button>
      </div>`;
    $('#pdEmptyNew').addEventListener('click', createProject);
    return;
  }
  wrap.innerHTML = projects.map((p) => {
    const isCurrent = p.id === currentProjectId;
    const modeLabel = p.preferences && p.preferences.scoringMode === 'custom' ? '按我的偏好' : '标准推荐';
    const rec = p.reportSnapshot && p.reportSnapshot.recommendedListingName
      ? `<div class="pc-rec">推荐：${p.reportSnapshot.recommendedListingName}</div>` : '';
    return `
      <div class="proj-card ${isCurrent ? 'current' : ''}" data-pid="${p.id}">
        <div class="pc-head">
          <span class="pc-title">${p.title}</span>
          ${isCurrent ? '<span class="pc-current-tag">当前打开</span>' : ''}
        </div>
        <div class="pc-meta">公司：${(p.workplace && p.workplace.address) || '未填写'}</div>
        <div class="pc-meta">${(p.listings || []).length} 套房源 · ${modeLabel} · 最后修改：${fmtRelativeTime(p.updatedAt)}</div>
        ${rec}
        <div class="pc-foot">
          <span class="pc-local">本地保存</span>
          <span class="pc-ops">
            <button data-op="open">继续编辑</button>
            <button data-op="rename">重命名</button>
            <button data-op="dup">复制</button>
            <button data-op="export">导出备份</button>
            <button data-op="del" class="op-del">删除</button>
          </span>
        </div>
      </div>`;
  }).join('');
}

function openDrawer() {
  saveNow(); // 打开列表前确保当前方案已落盘，卡片信息为最新
  renderProjectList();
  $('#drawerMask').classList.remove('hidden');
  $('#projDrawer').classList.add('open');
}
function closeDrawer() {
  $('#drawerMask').classList.add('hidden');
  $('#projDrawer').classList.remove('open');
}

/* ---------- 通用弹窗 ---------- */
function openModal(html) {
  $('#modalBox').innerHTML = html;
  $('#modalMask').classList.remove('hidden');
}
function closeModal() {
  $('#modalMask').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}

/* ---------- 初始化：恢复最近方案或创建默认方案 ---------- */
function initProjects() {
  const projects = loadProjects();
  const lastId = localStorage.getItem(LAST_OPEN_KEY);
  const recent = Object.values(projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const p = (lastId && projects[lastId]) || recent[0];
  if (p) {
    applyProject(p);
    localStorage.setItem(LAST_OPEN_KEY, p.id);
    syncInputsFromState();
    setSaveStatus('saved');
    showNotice('已恢复上次编辑内容。');
    setTimeout(checkStaleSnapshot, 400);
  } else {
    // 首次打开：创建默认「未命名选房方案」（含预置示例房源）
    currentProjectId = uid();
    currentProjectTitle = '未命名选房方案';
    projectCreatedAt = new Date().toISOString();
    saveNow();
  }
}

/* ---------- 工具函数 ---------- */
const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtMoney = (n) => Math.round(n).toLocaleString('zh-CN');
function parseTime(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function fmtTime(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/* 归一化为总和 100 的整数百分比 */
function normalize100(raw) {
  const keys = Object.keys(raw);
  const sum = keys.reduce((s, k) => s + Math.max(0, raw[k]), 0) || 1;
  const out = {};
  let acc = 0, maxKey = keys[0];
  keys.forEach((k) => {
    out[k] = Math.round((Math.max(0, raw[k]) / sum) * 100);
    acc += out[k];
    if (raw[k] > raw[maxKey]) maxKey = k;
  });
  out[maxKey] += 100 - acc;
  return out;
}
function amenityRange(a) {
  if (!a) return null;
  if (a.dist <= 1) return 1;
  if (a.dist <= 3) return 3;
  return 5;
}
function rangeScore(r, map = { 1: 100, 3: 70, 5: 40, 0: 10 }) {
  return r === null ? map[0] : map[r];
}
function amenityStatus(a) {
  const r = amenityRange(a);
  if (!r) return { text: '5km 内无', cls: 'pill-red' };
  if (r === 1) return { text: '有 · 很近', cls: 'pill-green' };
  if (r === 3) return { text: '有', cls: 'pill-blue' };
  return { text: '较远', cls: 'pill-orange' };
}

/* ---------- 通勤计算（消费高德路线规划结构化数据） ---------- */
function modeConservative(mode, opt) {
  return opt.duration + MODE_KIND[opt.kind].buffer + ARRIVAL_BUFFER;
}
/* ---------- 日常通勤可行性规则（两阶段推荐：先判断是否适合日常上班，再从中选推荐） ---------- */
const COMMUTE_RULES = {
  transit: { maxP50: 60 },                                  // 地铁/公交：常规 ≤ 60 分钟
  drive:   { maxP50: 60 },                                  // 驾车：常规 ≤ 60 分钟
  bike:    { maxDist: 8, maxP50: 35, maxCons: 45 },         // 骑行：≤8km 且常规 ≤35 且保守 ≤45
  walk:    { maxDist: 2, maxP50: 25, maxCons: 35 },         // 步行：≤2km 且常规 ≤25 且保守 ≤35
};
const SYS_MAX_CONS = 90; // 用户未设置通勤上限时的系统兜底（仅地铁/驾车）

/* 评估某种方式是否适合作为日常上班通勤 */
function evaluateMode(l, mode) {
  const opt = l.commute[mode];
  const cons = modeConservative(mode, opt);
  const departMin = parseTime(state.arriveTime) - cons;
  // 无效路线（夜班线路/异常/待核验/查询失败）：不参与推荐与 P50/P90 计算
  if (opt.invalid) {
    return { feasible: false, prefException: false, fails: [opt.invalidReason || '路线无效，未纳入推荐'], cons, departMin, invalid: true };
  }
  const maxC = state.constraints.maxCommute;
  const earliest = state.constraints.earliestDepart;
  const fails = [];
  const R = COMMUTE_RULES[mode];

  if (mode === 'transit' || mode === 'drive') {
    if (opt.duration > R.maxP50) fails.push(`常规通勤 ${opt.duration} 分钟，超过 ${R.maxP50} 分钟`);
    const cap = maxC.lv > 0 ? maxC.val : SYS_MAX_CONS;
    if (cons > cap) fails.push(`保守通勤 ${cons} 分钟，超过${maxC.lv > 0 ? `你的 ${cap} 分钟上限` : `${cap} 分钟`}`);
  } else {
    if (opt.distance > R.maxDist) fails.push(`${TRANSPORT_LABEL[mode]}距离 ${opt.distance} 公里，超过 ${R.maxDist} 公里`);
    if (opt.duration > R.maxP50) fails.push(`常规 ${opt.duration} 分钟，超过 ${R.maxP50} 分钟`);
    if (cons > R.maxCons) fails.push(`保守 ${cons} 分钟，超过 ${R.maxCons} 分钟`);
  }
  // 规则五-4：出发时间底线——用户未设置「最早出门」时默认不允许 06:30 前出门；
  // 用户设置后以其底线为准（设得比 06:30 早 = 明确允许早出门）
  const floor = earliest.lv > 0 ? parseTime(earliest.val) : 390;
  if (departMin < floor) {
    fails.push(earliest.lv > 0 ? `需 ${fmtTime(departMin)} 出发，早于你的底线 ${earliest.val}` : `需 ${fmtTime(departMin)} 出发，早于 06:30，不满足通勤底线`);
  }
  // 例外：用户明确偏好骑行/步行时放宽阈值，但必须提示风险
  const prefException = fails.length > 0 && state.prefTransport === mode && (mode === 'bike' || mode === 'walk');
  return { feasible: fails.length === 0 || prefException, prefException, fails, cons, departMin };
}

function getRecommendedCommute(l) {
  // 用户明确指定出行方式：直接采用（若不可行会附带提示，由渲染层展示）
  if (state.prefTransport !== 'mix') {
    const ev = evaluateMode(l, state.prefTransport);
    return { mode: state.prefTransport, ...l.commute[state.prefTransport], cons: ev.cons, departMin: ev.departMin, evals: { [state.prefTransport]: ev } };
  }
  const evals = {};
  TRANSPORT_MODES.forEach((m) => { evals[m] = evaluateMode(l, m); });
  const feasibleModes = TRANSPORT_MODES.filter((m) => evals[m].feasible);

  // 无合格方式：不推荐任何一种，仅取保守通勤最短的作为“最快可行方式”展示（无效路线除外）
  if (!feasibleModes.length) {
    const pool = TRANSPORT_MODES.filter((m) => !evals[m].invalid);
    const fastest = (pool.length ? pool : TRANSPORT_MODES).reduce((a, b) => (evals[a].cons <= evals[b].cons ? a : b));
    return { mode: fastest, ...l.commute[fastest], cons: evals[fastest].cons, departMin: evals[fastest].departMin, evals, unsuitable: true };
  }

  // 选择顺序：保守通勤更短 → 可靠性更高 → 换乘更少 → 日费用更低（费用仅作最后比较项）
  const kindOf = (m) => MODE_KIND[l.commute[m].kind];
  feasibleModes.sort((a, b) =>
    evals[a].cons - evals[b].cons
    || kindOf(b).relScore - kindOf(a).relScore
    || l.commute[a].transfers - l.commute[b].transfers
    || kindOf(a).fee - kindOf(b).fee
  );
  const m = feasibleModes[0];
  return { mode: m, ...l.commute[m], cons: evals[m].cons, departMin: evals[m].departMin, evals };
}

/* ---------- 成本计算 ---------- */
function actualMonthly(l) { return l.rent + Math.round(l.area * 4); }                 // 租金 + 估算水电物业
function transitMonthly(rec) { return Math.round(MODE_KIND[rec.kind].fee * 2 * 22); } // 单程费 × 2 × 22 工作日
function totalMonthly(l, rec) { return actualMonthly(l) + transitMonthly(rec); }

/* ---------- 维度子分 ---------- */
function metroWalkScore(walk) {
  if (walk <= 400) return 100;
  if (walk <= 800) return 85;
  if (walk <= 1200) return 60;
  if (walk <= 1500) return 40;
  return 20;
}
function bestRangeOf(l, keys) {
  let best = null;
  keys.forEach((k) => {
    const r = amenityRange(l.amenities[k]);
    if (r !== null && (best === null || r < best)) best = r;
  });
  return best;
}

function computeDimScores(l, rec, all) {
  const arrive = parseTime(state.arriveTime);
  const departMin = arrive - rec.cons;
  const kind = MODE_KIND[rec.kind];

  const commuteParts = {
    late:     clamp(Math.round(((departMin - (arrive - 150)) / 150) * 100), 0, 100),
    cons:     clamp(Math.round(100 - Math.max(0, rec.cons - 25) * 1.6), 0, 100),
    rel:      kind.relScore,
    metro:    metroWalkScore(l.station.walk),
    transfer: rec.kind.startsWith('metro')
      ? (rec.transfers === 0 ? 100 : rec.transfers === 1 ? 80 : rec.transfers === 2 ? 55 : 30)
      : 85,
    fee:      (() => { const f = transitMonthly(rec); return f <= 100 ? 100 : f <= 250 ? 85 : f <= 450 ? 60 : f <= 800 ? 40 : 20; })(),
  };
  const lifeParts = {
    metroNear: metroWalkScore(l.station.walk),
    daily:     rangeScore(bestRangeOf(l, ['hema', 'aldi', 'market'])),
    bigStore:  rangeScore(bestRangeOf(l, ['sam', 'rt'])),
    hospital:  rangeScore(amenityRange(l.amenities.hospital)),
    park:      rangeScore(amenityRange(l.amenities.park)),
  };
  const edu = rangeScore(amenityRange(l.amenities.school), { 1: 100, 3: 75, 5: 45, 0: 15 });
  const areas = all.map((x) => x.area);
  const minA = Math.min(...areas), maxA = Math.max(...areas);
  const areaScore = maxA === minA ? 80 : Math.round(60 + ((l.area - minA) / (maxA - minA)) * 40);
  const facingScore = l.facing.includes('南北') ? 100 : l.facing === '南' ? 95 : /东南|西南/.test(l.facing) ? 85 : /东|西/.test(l.facing) ? 70 : 55;
  const fm = String(l.floor).match(/(\d+)\s*\/\s*(\d+)/);
  const floorScore = fm ? ((fm[1] / fm[2] >= 0.3 && fm[1] / fm[2] <= 0.8) ? 100 : 75) : 80;
  const privacyScore = (l.rentType === '整租' && l.bath === '独卫') ? 100 : (l.rentType === '整租' || l.bath === '独卫') ? 80 : 55;
  const living = Math.round(areaScore * 0.4 + facingScore * 0.25 + floorScore * 0.15 + privacyScore * 0.2);
  const totals = all.map((x) => totalMonthly(x, getRecommendedCommute(x)));
  const minT = Math.min(...totals), maxT = Math.max(...totals);
  const rel = maxT === minT ? 85 : Math.round(100 - ((totalMonthly(l, rec) - minT) / (maxT - minT)) * 45);
  const ratio = state.budget > 0 ? totalMonthly(l, rec) / state.budget : 1;
  const budgetFit = ratio <= 1 ? 100 : clamp(Math.round(100 - (ratio - 1) * 200), 0, 100);
  const cost = Math.round(rel * 0.7 + budgetFit * 0.3);

  return { commuteParts, lifeParts, edu, living, cost, departMin };
}

/* ---------- 底线判定 ---------- */
function checkConstraint(key, val, c) {
  // 返回 { sev: 'ok'|'minor'|'major', text }
  switch (key) {
    case 'budget': {
      const over = c.actual - state.budget;
      if (over <= 0) return { sev: 'ok', text: `实际月支出 ${fmtMoney(c.actual)} 元，在预算 ${fmtMoney(state.budget)} 元内` };
      return over <= state.budget * 0.05
        ? { sev: 'minor', text: `实际月支出 ${fmtMoney(c.actual)} 元，略超预算 ${fmtMoney(over)} 元` }
        : { sev: 'major', text: `实际月支出 ${fmtMoney(c.actual)} 元，超预算 ${fmtMoney(over)} 元` };
    }
    case 'maxCommute': {
      const over = c.rec.cons - val;
      if (over <= 0) return { sev: 'ok', text: `保守通勤 ${c.rec.cons} 分钟，不超过 ${val} 分钟` };
      return over <= 10
        ? { sev: 'minor', text: `保守通勤 ${c.rec.cons} 分钟，略超上限 ${over} 分钟` }
        : { sev: 'major', text: `保守通勤 ${c.rec.cons} 分钟，超上限 ${over} 分钟` };
    }
    case 'earliestDepart': {
      const early = parseTime(val) - c.departMin;
      if (early <= 0) return { sev: 'ok', text: `${fmtTime(c.departMin)} 出发，不早于 ${val}` };
      return early <= 10
        ? { sev: 'minor', text: `需 ${fmtTime(c.departMin)} 出发，略早于底线 ${val}` }
        : { sev: 'major', text: `需 ${fmtTime(c.departMin)} 出发，早于底线 ${val}` };
    }
    case 'metro': {
      const w = c.station.walk;
      if (w <= 1200) return { sev: 'ok', text: `地铁站步行 ${w} 米` };
      return w <= 1500 ? { sev: 'minor', text: `地铁站步行 ${w} 米，略远` } : { sev: 'major', text: `地铁站步行 ${w} 米，不满足地铁可达` };
    }
    case 'daily': {
      const r = bestRangeOf(c, ['hema', 'aldi', 'market']);
      if (r !== null && r <= 3) return { sev: 'ok', text: `${r}km 内有日常采购场所` };
      return r === 5 ? { sev: 'minor', text: '日常采购场所较远（3–5km）' } : { sev: 'major', text: '5km 内无盒马/奥乐齐/菜场' };
    }
    case 'sam': {
      const r = amenityRange(c.amenities.sam);
      if (r !== null && r <= 3) return { sev: 'ok', text: `山姆 ${c.amenities.sam.dist}km` };
      return r === 5 ? { sev: 'minor', text: `山姆较远（${c.amenities.sam.dist}km）` } : { sev: 'major', text: '5km 内无山姆' };
    }
    case 'hospital': {
      const r = amenityRange(c.amenities.hospital);
      if (r !== null && r <= 3) return { sev: 'ok', text: `医院 ${c.amenities.hospital.dist}km` };
      return r === 5 ? { sev: 'minor', text: `医院较远（${c.amenities.hospital.dist}km）` } : { sev: 'major', text: '5km 内无医院' };
    }
    case 'school': {
      const r = amenityRange(c.amenities.school);
      if (r !== null && r <= 3) return { sev: 'ok', text: `学校 ${c.amenities.school.dist}km（不代表学区资格）` };
      return r === 5 ? { sev: 'minor', text: `学校较远（${c.amenities.school.dist}km）` } : { sev: 'major', text: '5km 内无学校' };
    }
    case 'minArea': {
      const short = val - c.area;
      if (short <= 0) return { sev: 'ok', text: `面积 ${c.area}㎡，满足最低 ${val}㎡` };
      return short <= 5 ? { sev: 'minor', text: `面积 ${c.area}㎡，略低于底线 ${val}㎡` } : { sev: 'major', text: `面积 ${c.area}㎡，低于底线 ${val}㎡` };
    }
    case 'wholeRent':
      return c.rentType === '整租' ? { sev: 'ok', text: '整租' } : { sev: 'major', text: '非整租，不满足底线' };
    case 'privateBath':
      return c.bath === '独卫' ? { sev: 'ok', text: '独卫' } : { sev: 'major', text: '无独卫，不满足底线' };
    default:
      return { sev: 'ok', text: '' };
  }
}

/* ---------- 权重计算 ---------- */
function personalRawWeights() {
  if (state.customTopWeights) return { ...state.customTopWeights };
  const w = { ...STD_WEIGHTS };
  state.selectedPrefs.forEach((key) => {
    const p = PREFS.find((x) => x.key === key);
    Object.entries(p.w).forEach(([d, delta]) => { w[d] = Math.max(2, w[d] + delta); });
  });
  CONSTRAINTS.forEach((c) => {
    if (state.constraints[c.key].lv === 2) w[c.dim] += 8; // 「很重要」提高对应维度权重
  });
  return w;
}
function effectiveWeights() {
  return state.mode === 'standard' ? { ...STD_WEIGHTS } : normalize100(personalRawWeights());
}
function effectiveCommuteSub() {
  const raw = { ...state.commuteSub };
  state.selectedPrefs.forEach((key) => {
    const p = PREFS.find((x) => x.key === key);
    if (p.subC) Object.entries(p.subC).forEach(([k, d]) => { raw[k] = (raw[k] || 0) + d; });
  });
  return normalize100(raw);
}
function effectiveLifeSub() {
  const raw = { ...state.lifeSub };
  state.selectedPrefs.forEach((key) => {
    const p = PREFS.find((x) => x.key === key);
    if (p.subL) Object.entries(p.subL).forEach(([k, d]) => { raw[k] = (raw[k] || 0) + d; });
  });
  return normalize100(raw);
}

/* ---------- 核心计算 ---------- */
function computeAll() {
  const subC = effectiveCommuteSub();
  const subL = effectiveLifeSub();

  // 只计算真实数据已就绪的房源（无模拟数据，未加载成功的房源不参与评分）
  state.computed = state.listings.filter((l) => l.commute && l.station && l.amenities).map((l) => {
    const idx = state.listings.indexOf(l); // 字母/颜色锚定原始顺序，不受加载失败房源影响
    const rec = getRecommendedCommute(l);
    const d = computeDimScores(l, rec, state.listings);

    // 「希望有」且满足 → 对应维度小额加分
    const bonus = { commute: 0, cost: 0, life: 0, edu: 0, living: 0 };
    const base = { ...l, idx, rec, departMin: d.departMin, actual: actualMonthly(l), total: totalMonthly(l, rec) };
    CONSTRAINTS.forEach((c) => {
      const st = state.constraints[c.key];
      if (st.lv === 1 && checkConstraint(c.key, st.val, base).sev === 'ok') bonus[c.dim] += 4;
    });

    const commuteScore = clamp(Math.round(
      COMMUTE_SUBS.reduce((s, sub) => s + d.commuteParts[sub.key] * (subC[sub.key] / 100), 0)
    ) + bonus.commute, 0, 100);
    const lifeScore = clamp(Math.round(
      LIFE_SUBS.reduce((s, sub) => s + d.lifeParts[sub.key] * (subL[sub.key] / 100), 0)
    ) + bonus.life, 0, 100);
    const dimScores = {
      commute: commuteScore,
      cost: clamp(d.cost + bonus.cost, 0, 100),
      life: lifeScore,
      edu: clamp(d.edu + bonus.edu, 0, 100),
      living: clamp(d.living + bonus.living, 0, 100),
    };

    // 硬约束判定
    const checks = [];
    CONSTRAINTS.forEach((c) => {
      const st = state.constraints[c.key];
      if (st.lv === 3) checks.push({ key: c.key, label: c.label, ...checkConstraint(c.key, st.val, base) });
    });
    const hasMajor = checks.some((x) => x.sev === 'major');
    const hasMinor = checks.some((x) => x.sev === 'minor');
    let status = hasMajor ? 'ineligible' : hasMinor ? 'conditional' : 'eligible';
    // 两阶段规则：没有合格日常通勤方式的房源，状态至少降为「可考虑」
    if (rec.unsuitable && status === 'eligible') status = 'conditional';

    return {
      ...base, dimScores, commuteParts: d.commuteParts, lifeParts: d.lifeParts,
      checks, status, subC, subL,
    };
  });

  // 两种模式的排名（ineligible 固定排在最后）
  const rankFor = (weights) => {
    const order = [...state.computed].sort((a, b) => {
      const rs = { eligible: 0, conditional: 1, ineligible: 2 };
      if (rs[a.status] !== rs[b.status]) return rs[a.status] - rs[b.status];
      return scoreOf(b, weights) - scoreOf(a, weights);
    });
    const ranks = {};
    order.forEach((c, i) => { ranks[c.id] = i + 1; });
    return ranks;
  };
  state.stdRanks = rankFor(STD_WEIGHTS);
  state.personalRanks = rankFor(normalize100(personalRawWeights()));
  state.weights = effectiveWeights();
}
function scoreOf(c, weights) {
  return Math.round(DIMS.reduce((s, d) => s + c.dimScores[d.key] * (weights[d.key] / 100), 0));
}
function currentRanks() { return state.mode === 'standard' ? state.stdRanks : state.personalRanks; }
function currentOrder() {
  const ranks = currentRanks();
  return [...state.computed].sort((a, b) => ranks[a.id] - ranks[b.id]);
}
function getComputed(id) { return state.computed.find((c) => c.id === id); }

/* ---------- 规则生成的推荐解释（不依赖 AI） ---------- */
function ruleExplain(c) {
  const rank = currentRanks()[c.id];
  const bullets = [];
  const kind = MODE_KIND[c.rec.kind];
  if (c.rec.unsuitable) {
    bullets.push(`没有满足日常通勤可行性规则的方式，不作通勤方式推荐；最快可行方式为${TRANSPORT_LABEL[c.rec.mode]}：保守通勤 ${c.rec.cons} 分钟，建议 ${fmtTime(c.departMin)} 出发；`);
  } else {
    bullets.push(`保守通勤 ${c.rec.cons} 分钟（${TRANSPORT_LABEL[c.rec.mode]} · 常规 ${c.rec.duration} + 波动缓冲 ${kind.buffer} + 到楼缓冲 ${ARRIVAL_BUFFER}），可于 ${fmtTime(c.departMin)} 出发；`);
  }
  c.checks.forEach((ch) => {
    bullets.push(ch.sev === 'ok' ? `满足底线：${ch.text}；` : ch.sev === 'minor' ? `轻微超出：${ch.text}；` : `不满足底线：${ch.text}；`);
  });
  if (state.budget > 0) bullets.push(`实际月支出 ${fmtMoney(c.actual)} 元/月，占预算 ${Math.round((c.actual / state.budget) * 100)}%；`);
  const near = Object.entries(c.amenities)
    .filter(([, a]) => amenityRange(a) === 1)
    .map(([k]) => AMENITY_META[k].label);
  bullets.push(near.length ? `1km 内有：${near.join('、')}；` : '1km 内核心配套较少；');
  const weakest = DIMS.reduce((a, d) => (c.dimScores[d.key] < c.dimScores[a.key] ? d : a), DIMS[0]);
  const wv = c.dimScores[weakest.key];
  if (wv < 60) bullets.push(`主要不足：${weakest.label}维度偏弱（${wv} 分）。`);
  return { title: `房源 ${String.fromCharCode(65 + c.idx)}（${c.name}）当前模式排名第 ${rank}`, bullets };
}

/* =========================================================
 * 视图导航
 * ========================================================= */
const VIEW_ORDER = ['step1', 'step2', 'step3', 'result'];
function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $('#topbar').classList.toggle('hidden', name === 'welcome');
  // 通知 React AI 助手面板当前视图（AI 入口仅在结果页显示）
  window.dispatchEvent(new CustomEvent('zhunaer:viewchange', { detail: name }));
  // 进度条状态
  const idx = VIEW_ORDER.indexOf(name);
  document.querySelectorAll('.prog-item').forEach((el) => {
    const i = VIEW_ORDER.indexOf(el.dataset.goto);
    el.classList.toggle('current', i === idx);
    el.classList.toggle('done', i >= 0 && idx > i); // 首页等非步骤项不标记完成态
  });
  if (name === 'step2') {
    computeAll(); renderListingCards(); renderDataState();
    setMapLoading(true);
    ensureRealData().then((ok) => {
      setMapLoading(false);
      if (ok) initAmapMap();
      computeAll(); renderListingCards();
      renderMap(); mapFitAll(); renderDataState();
      if (ok) scheduleSave(); // 路线/POI 数据更新后自动保存
    });
  }
  if (name === 'step3') { renderPrefWall(); renderPrefProfile(); renderModeCards(); renderSliders(); }
  if (name === 'result') { renderResult(); }
  window.scrollTo({ top: 0 });
}

/* =========================================================
 * 第 1 步：通勤与底线
 * ========================================================= */
function renderConstraints() {
  const wrap = $('#constraintGrid');
  wrap.innerHTML = '';
  CONSTRAINTS.forEach((c) => {
    const st = state.constraints[c.key];
    const div = document.createElement('div');
    div.className = 'constraint-item' + (st.lv === 3 ? ' hard' : '');
    let valueHtml = '';
    if (c.type === 'budget') {
      valueHtml = `<span class="c-value"><span class="c-caps" data-ccaps="budget">
          ${c.caps.map((v) => `<button data-v="${v}" class="${state.budget === v ? 'active' : ''}">¥${fmtMoney(v)}</button>`).join('')}
        </span><input type="number" data-cval="budget" value="${state.budget}" step="500"> 元</span>`;
    } else if (c.type === 'number') {
      valueHtml = `<span class="c-value"><span class="c-caps" data-ccaps="${c.key}">
          ${c.caps.map((v) => `<button data-v="${v}" class="${st.val === v ? 'active' : ''}">${v}</button>`).join('')}
        </span><input type="number" data-cval="${c.key}" value="${st.val}"> ${c.unit}</span>`;
    } else if (c.type === 'time') {
      valueHtml = `<span class="c-value"><input type="time" data-cval="${c.key}" value="${st.val}"></span>`;
    }
    div.innerHTML = `
      <div class="c-label">${c.label} ${valueHtml}</div>
      <div class="seg" data-ckey="${c.key}">
        ${LEVELS.map((lv, i) => `<button type="button" data-lv="${i}" class="${st.lv === i ? 'active' : ''}">${lv}</button>`).join('')}
      </div>`;
    wrap.appendChild(div);
  });
  renderBottomline();
}

function renderBottomline() {
  const items = [];
  CONSTRAINTS.forEach((c) => {
    const st = state.constraints[c.key];
    if (st.lv !== 3) return;
    if (c.key === 'budget') items.push(`预算 ≤ ¥${fmtMoney(state.budget)}`);
    else if (c.key === 'maxCommute') items.push(`保守通勤 ≤ ${st.val} 分钟`);
    else if (c.key === 'earliestDepart') items.push(`出发不早于 ${st.val}`);
    else if (c.key === 'minArea') items.push(`面积 ≥ ${st.val}㎡`);
    else items.push(c.label.replace(/^附近/, '必须'));
  });
  $('#bottomlineBar').classList.toggle('hidden', !items.length);
  $('#bottomlineText').textContent = items.join(' · ');
}

/* =========================================================
 * 第 2 步：房源卡片 + 高德真实地图
 * ========================================================= */
function renderListingCards() {
  const wrap = $('#listingList');
  wrap.innerHTML = '';
  state.listings.forEach((l, i) => {
    const c = getComputed(l.id);
    const div = document.createElement('div');
    div.className = 'listing-card' + (l.id === state.selectedId ? ' selected' : '');
    div.dataset.lcard = l.id;
    div.innerHTML = `
      <div class="lc-head" data-select="${l.id}">
        <span class="lc-letter" style="background:${LISTING_COLORS[i % LISTING_COLORS.length]}">${String.fromCharCode(65 + i)}</span>
        <span class="lc-name">${l.name}</span>
        <button class="lc-del" data-del="${l.id}" title="删除" ${state.listings.length <= 2 ? 'disabled style="opacity:.2"' : ''}>×</button>
      </div>
      <div class="lc-meta">¥${fmtMoney(l.rent)}/月 · ${l.area}㎡ · ${l.layout} · ${l.rentType}</div>
      ${l._failed
        ? '<div class="lc-depart" style="color:var(--risk)">真实数据加载失败，请检查地址后重新输入</div>'
        : c ? `<div class="lc-depart">推荐：${fmtTime(c.departMin)} 出发 · 保守通勤 ${c.rec.cons} 分钟</div>`
        : '<div class="lc-depart">正在获取真实通勤数据…</div>'}
      <div class="lc-form">
        <div class="span2"><label>房源名称</label><input type="text" data-id="${l.id}" data-f="name" value="${l.name}"></div>
        <div class="span2"><label>地址</label><input type="text" data-id="${l.id}" data-f="address" value="${l.address}"></div>
        <div><label>月租（元）</label><input type="number" data-id="${l.id}" data-f="rent" value="${l.rent}"></div>
        <div><label>面积（㎡）</label><input type="number" data-id="${l.id}" data-f="area" value="${l.area}"></div>
        <div><label>户型</label><input type="text" data-id="${l.id}" data-f="layout" value="${l.layout}"></div>
        <div><label>楼层</label><input type="text" data-id="${l.id}" data-f="floor" value="${l.floor}"></div>
        <div><label>朝向</label><input type="text" data-id="${l.id}" data-f="facing" value="${l.facing}"></div>
        <div><label>租赁方式</label><select data-id="${l.id}" data-f="rentType">
          <option ${l.rentType === '整租' ? 'selected' : ''}>整租</option><option ${l.rentType === '合租' ? 'selected' : ''}>合租</option></select></div>
        <div><label>卫生间</label><select data-id="${l.id}" data-f="bath">
          <option ${l.bath === '独卫' ? 'selected' : ''}>独卫</option><option ${l.bath === '公卫' ? 'selected' : ''}>公卫</option></select></div>
        <div><label>备注</label><input type="text" data-id="${l.id}" data-f="note" value="${l.note}"></div>
      </div>`;
    wrap.appendChild(div);
  });
  $('#addListingBtn').disabled = state.listings.length >= 5;
  // 滚动侦测：重新挂载观察卡片
  document.querySelectorAll('[data-lcard]').forEach((el) => listingSpy.observe(el));
}

/* 滚动浏览房源列表时，自动选中位于视口中心的房源（地图保持固定不动） */
let step2Scrolled = false;
window.addEventListener('scroll', () => { if (state.view === 'step2') step2Scrolled = true; }, { passive: true });
const listingSpy = new IntersectionObserver((entries) => {
  if (!step2Scrolled || state.view !== 'step2') return;
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    const id = Number(en.target.dataset.lcard);
    if (id && id !== state.selectedId) {
      state.selectedId = id;
      renderListingCards();
      renderMap();
      mapFocusSelected();
    }
  });
}, { rootMargin: '-42% 0px -42% 0px' });

/* ---------- 地图渲染（仅高德真实地图，无模拟地图） ---------- */
function mapFitAll() {
  if (amapMap) amapMap.setFitView(null, false, [80, 80, 80, 80]);
}
function mapFocusSelected() {
  if (!amapMap) return;
  const sel = amapOverlays.pins.find((p) => p.id === state.selectedId);
  const targets = [sel && sel.pin, amapOverlays.company].filter(Boolean);
  if (targets.length === 2) amapMap.setFitView(targets, false, [140, 140, 140, 140]);
  else amapMap.setFitView(null, false, [80, 80, 80, 80]);
}

function renderMap() {
  if (state.view !== 'step2' || !amapMap) return;
  renderRealMap();
}

function renderMapInfo() {
  const l = state.listings.find((x) => x.id === state.selectedId);
  if (!l || !l.commute) { $('#mapInfo').innerHTML = ''; return; }
  const i = state.listings.indexOf(l);
  const opt = l.commute[state.mapMode];
  // 该方式路线查询失败（接口异常）：明确提示，不崩溃
  if (!opt) {
    $('#mapInfo').innerHTML = `
      <div class="mi-mode">房源 ${String.fromCharCode(65 + i)} · ${TRANSPORT_LABEL[state.mapMode]}</div>
      <div class="mi-sub">该方式路线查询失败，请点「全部」或重新进入本页重试。</div>`;
    return;
  }
  // 无效路线（夜班/异常/待核验）：不展示时长，只显示原因
  if (opt.invalid) {
    $('#mapInfo').innerHTML = `
      <div class="mi-mode">房源 ${String.fromCharCode(65 + i)} · ${TRANSPORT_LABEL[state.mapMode]}</div>
      <div class="mi-sub">暂未获得适合工作日早高峰的有效路线。${opt.invalidReason}</div>`;
    return;
  }
  const cons = modeConservative(state.mapMode, opt);
  const depart = parseTime(state.arriveTime) - cons;
  const dailyFee = Math.round(MODE_KIND[opt.kind].fee * 2);
  $('#mapInfo').innerHTML = `
    <div class="mi-mode">房源 ${String.fromCharCode(65 + i)} · 推荐${TRANSPORT_LABEL[state.mapMode]}通勤</div>
    <div class="mi-time">${fmtTime(depart)}</div>
    <div class="mi-sub">建议最晚出发 · 保守通勤 ${cons} 分钟</div>
    <div class="mi-sub">常规 ${opt.duration} 分钟 · ${opt.distance} 公里 · 换乘 ${opt.transfers} 次 · ${dailyFee} 元/天</div>`;
}

/* 结果页 Hero 的小地图（基于真实经纬度的相对方位示意图） */
function miniMapSvg(c) {
  const company = state._companyGeo ? lnglatToVirtual(state._companyGeo.lnglat) : { x: 660, y: 290 };
  const home = c.coord || company;
  const xs = [home.x, company.x], ys = [home.y, company.y];
  const w = Math.max(Math.abs(xs[0] - xs[1]), 160), h = Math.max(Math.abs(ys[0] - ys[1]), 160);
  const vb = `${Math.min(...xs) - w * 0.35} ${Math.min(...ys) - h * 0.4} ${w * 1.7} ${h * 1.8}`;
  const color = LISTING_COLORS[c.idx % LISTING_COLORS.length];
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice">
    <rect x="-2000" y="-2000" width="5000" height="5000" fill="#10201E"/>
    <path d="M${home.x} ${home.y} L${company.x} ${company.y}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${home.x}" cy="${home.y}" r="17" fill="${color}" stroke="#F7F6F2" stroke-width="2.5"/>
    <text x="${home.x}" y="${home.y + 5}" text-anchor="middle" fill="#fff" font-size="14" font-weight="800">${String.fromCharCode(65 + c.idx)}</text>
    <rect x="${company.x - 15}" y="${company.y - 15}" width="30" height="30" rx="8" fill="#18201E" stroke="#C9A66B" stroke-width="2.5"/>
    <text x="${company.x}" y="${company.y + 5}" text-anchor="middle" fill="#C9A66B" font-size="13" font-weight="800">司</text>
  </svg>`;
}

/* =========================================================
 * 第 3 步：我的偏好
 * ========================================================= */
function renderPrefWall() {
  const wrap = $('#prefWall');
  wrap.innerHTML = '';
  PREFS.forEach((p) => {
    const active = state.selectedPrefs.includes(p.key);
    const btn = document.createElement('button');
    btn.className = 'pref-card' + (active ? ' active' : '');
    btn.dataset.pref = p.key;
    if (!active && state.selectedPrefs.length >= 3) btn.disabled = true;
    btn.innerHTML = `<div class="pc-icon">${p.icon}</div><div class="pc-title">${p.label}</div><div class="pc-sub">${p.sub}</div>`;
    wrap.appendChild(btn);
  });
}

function renderPrefProfile() {
  const el = $('#prefProfile');
  if (!state.selectedPrefs.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  const names = state.selectedPrefs.map((k) => PREFS.find((p) => p.key === k).label);
  const w = { commute: 0, cost: 0, life: 0, edu: 0, living: 0 };
  state.selectedPrefs.forEach((k) => {
    const p = PREFS.find((x) => x.key === k);
    Object.entries(p.w).forEach(([d, delta]) => { w[d] += delta; });
  });
  const label = (k) => DIMS.find((d) => d.key === k).label;
  const ups = Object.entries(w).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k]) => label(k));
  const downs = Object.entries(w).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).map(([k]) => label(k));
  const weights = normalize100(personalRawWeights());
  el.innerHTML = `<b>你的决策画像</b>：更重视 ${names.join('、')}。系统会提高${ups.slice(0, 2).join('与')}的影响，降低${downs.slice(0, 2).join('和')}的影响。建议权重：${DIMS.map((d) => `${d.label} ${weights[d.key]}%`).join(' / ')}`;
}

function renderModeCards() {
  document.querySelectorAll('#modeCards .mode-card').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });
}

function renderSliders() {
  const topRaw = personalRawWeights();
  const topNorm = normalize100(topRaw);
  $('#topSliders').innerHTML = DIMS.map((d) => `
    <div class="slider-row">
      <label>${d.label}</label>
      <input type="range" min="0" max="100" value="${Math.round(topRaw[d.key])}" data-slider="top" data-key="${d.key}">
      <span class="sv" data-sv="top-${d.key}">${topNorm[d.key]}%</span>
    </div>`).join('');
  $('#commuteSliders').innerHTML = COMMUTE_SUBS.map((s) => `
    <div class="slider-row">
      <label>${s.label}</label>
      <input type="range" min="0" max="100" value="${state.commuteSub[s.key]}" data-slider="commute" data-key="${s.key}">
      <span class="sv" data-sv="commute-${s.key}">${effectiveCommuteSub()[s.key]}%</span>
    </div>`).join('');
  $('#lifeSliders').innerHTML = LIFE_SUBS.map((s) => `
    <div class="slider-row">
      <label>${s.label}</label>
      <input type="range" min="0" max="100" value="${state.lifeSub[s.key]}" data-slider="life" data-key="${s.key}">
      <span class="sv" data-sv="life-${s.key}">${effectiveLifeSub()[s.key]}%</span>
    </div>`).join('');
}

/* =========================================================
 * 结果页
 * ========================================================= */
const STATUS_META = {
  eligible:    { text: '推荐', cls: 'pill-green' },
  conditional: { text: '可考虑', cls: 'pill-orange' },
  ineligible:  { text: '不满足核心条件', cls: 'pill-red' },
};

function renderHero() {
  const order = currentOrder();
  const top = order.find((c) => c.status !== 'ineligible');
  const el = $('#heroPanel');

  if (!top) {
    el.innerHTML = `<div class="hero-none">
      <h3>当前没有满足全部底线的房源</h3>
      <p class="cell-sub">所有房源均违反了「必须满足」条件。建议返回第 1 步放宽底线。</p>
      <button class="btn-next" style="margin-top:16px" data-goto="step1">返回修改底线</button>
    </div>`;
    return;
  }

  const score = scoreOf(top, state.weights);
  const kind = MODE_KIND[top.rec.kind];
  // 三条推荐理由
  const reasons = [];
  const maxC = state.constraints.maxCommute;
  if (maxC.lv > 0) reasons.push(`保守通勤 ${top.rec.cons} 分钟，${top.rec.cons <= maxC.val ? `低于你的 ${maxC.val} 分钟上限` : `略超 ${maxC.val} 分钟上限`}`);
  else reasons.push(`保守通勤 ${top.rec.cons} 分钟（${TRANSPORT_LABEL[top.rec.mode]} · ${kind.label} · 可靠性「${kind.rel}」）`);
  if (state.budget > 0) reasons.push(`实际月支出 ${fmtMoney(top.actual)} 元，占预算 ${Math.round(top.actual / state.budget * 100)}%`);
  const near = Object.entries(top.amenities).filter(([, a]) => amenityRange(a) === 1).map(([k]) => AMENITY_META[k].label);
  if (near.length) reasons.push(`1km 内有${near.slice(0, 3).join('、')}`);
  // 风险
  const risks = [];
  if (top.rec.unsuitable) risks.push(`暂无适合作为日常上班的通勤方案。最快可行方式为${TRANSPORT_LABEL[top.rec.mode]}：保守通勤 ${top.rec.cons} 分钟，建议 ${fmtTime(top.departMin)} 出发`);
  if (top.status === 'conditional') risks.push(...top.checks.filter((x) => x.sev === 'minor').map((x) => x.text));
  const weakest = DIMS.reduce((a, d) => (top.dimScores[d.key] < top.dimScores[a.key] ? d : a), DIMS[0]);
  if (top.dimScores[weakest.key] < 60) risks.push(`${weakest.label}维度偏弱（${top.dimScores[weakest.key]} 分）`);
  const pool = state.computed.filter((c) => c.status !== 'ineligible');
  const cheaper = pool.find((c) => c !== top && c.actual < top.actual);
  if (cheaper) risks.push(`实际月支出比「${cheaper.name}」高 ${fmtMoney(top.actual - cheaper.actual)} 元/月`);

  const C = 2 * Math.PI * 56;
  el.innerHTML = `
    <div>
      <div class="hero-kicker">你的最佳选择 · ${state.mode === 'standard' ? '标准推荐' : '按我的偏好'}</div>
      <div class="hero-name">${top.name}</div>
      <div class="hero-addr">${top.address} · ¥${fmtMoney(top.rent)}/月 · ${top.area}㎡ · ${top.layout}</div>
      <ul class="hero-reasons">${reasons.slice(0, 3).map((r) => `<li>${r}</li>`).join('')}</ul>
      <div class="hero-risk">需要权衡：${risks.length ? risks.join('；') : '各维度表现均衡，无明显短板。'}</div>
    </div>
    <div class="hero-mid">
      <div class="hero-score-ring">
        <svg width="130" height="130">
          <circle cx="65" cy="65" r="56" fill="none" stroke="#ECEAE3" stroke-width="10"/>
          <circle cx="65" cy="65" r="56" fill="none" stroke="#2E8B72" stroke-width="10"
            stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - score / 100)}"/>
        </svg>
        <div class="hero-score-num"><b>${score}</b><span>综合适配分</span></div>
      </div>
      <div class="hero-depart">
        <div class="hd-label">工作日 ${state.arriveTime} 到公司，建议最晚</div>
        <div class="hd-time">${fmtTime(top.departMin)}</div>
        <div class="hd-sub">${TRANSPORT_LABEL[top.rec.mode]} · 常规 ${top.rec.duration} 分钟 · 保守 ${top.rec.cons} 分钟</div>
      </div>
    </div>
    <div class="hero-map">${miniMapSvg(top)}</div>`;
}

function renderPicks() {
  const pool = state.computed.filter((c) => c.status !== 'ineligible');
  if (!pool.length) { $('#picksRow').innerHTML = ''; return; }
  const picks = [
    ['通勤最佳', pool.reduce((a, b) => (b.rec.cons < a.rec.cons ? b : a)), (c) => `保守 ${c.rec.cons} 分钟`],
    ['最晚出门最佳', pool.reduce((a, b) => (b.departMin > a.departMin ? b : a)), (c) => `${fmtTime(c.departMin)} 出发`],
    ['生活便利最佳', pool.reduce((a, b) => (b.dimScores.life > a.dimScores.life ? b : a)), (c) => `生活 ${c.dimScores.life} 分`],
    ['预算最友好', pool.reduce((a, b) => (b.actual < a.actual ? b : a)), (c) => `${fmtMoney(c.actual)} 元/月`],
    ['综合月成本最低', pool.reduce((a, b) => (b.total < a.total ? b : a)), (c) => `${fmtMoney(c.total)} 元/月`],
  ];
  $('#picksRow').innerHTML = picks.map(([label, c, fn]) =>
    `<div class="pick-chip"><b>${label}</b><span>${c.name}</span> · ${fn(c)}</div>`).join('');
}

/* ---------- 横向对比卡片 ---------- */
function renderHcards() {
  const order = currentOrder();
  const ranks = currentRanks();
  const w = state.weights;
  $('#hcards').innerHTML = order.map((c) => {
    const rank = ranks[c.id];
    const st = STATUS_META[c.status];
    const strongest = DIMS.reduce((a, d) => (c.dimScores[d.key] > c.dimScores[a.key] ? d : a), DIMS[0]);
    const weakest = DIMS.reduce((a, d) => (c.dimScores[d.key] < c.dimScores[a.key] ? d : a), DIMS[0]);
    const viol = c.checks.filter((x) => x.sev !== 'ok');
    return `<div class="hcard ${rank === 1 ? 'first' : ''} ${c.status === 'ineligible' ? 'ineligible' : ''}">
      <div class="hc-rank"><span>第 ${rank} 名 · ${state.mode === 'standard' ? '标准推荐' : '我的偏好'}</span>
        <span class="pill ${st.cls}">${st.text}</span></div>
      <div class="hc-name">${c.name}</div>
      <div class="hc-addr">${c.address}</div>
      <div class="hc-grid">
        <div class="hg"><b>${scoreOf(c, w)}</b><span>综合适配分</span></div>
        <div class="hg depart"><b>${fmtTime(c.departMin)}</b><span>最晚出发</span></div>
        <div class="hg"><b>${c.rec.cons}<span class="unit"> 分钟</span></b><span>保守通勤（${TRANSPORT_LABEL[c.rec.mode]}）</span></div>
        <div class="hg"><b>${fmtMoney(c.actual)}</b><span>实际月支出（元）</span></div>
      </div>
      <div class="hc-good">${strongest.label}最强（${c.dimScores[strongest.key]} 分）</div>
      <div class="hc-bad">${weakest.label}相对偏弱（${c.dimScores[weakest.key]} 分）</div>
      ${viol.length ? `<div class="hc-violations">${viol.map((v) => v.text).join('；')}</div>` : ''}
    </div>`;
  }).join('');
}

/* ---------- 评分说明 ---------- */
function scoreExplainHtml(c) {
  const w = state.weights;
  const rows = DIMS.map((d) => {
    const s = c.dimScores[d.key];
    const color = s >= 75 ? 'var(--emerald)' : s >= 55 ? 'var(--warn)' : 'var(--risk)';
    return `<div class="se-row">
      <span class="se-label">${d.label}</span>
      <div class="se-bar"><i style="width:${s}%;background:${color}"></i></div>
      <span class="se-val">${s} 分 × ${w[d.key]}% = ${(s * w[d.key] / 100).toFixed(1)}</span>
    </div>`;
  }).join('');
  const violations = c.checks.filter((x) => x.sev !== 'ok');
  return `${rows}
    <div class="se-note">综合适配分 = ${scoreOf(c, w)}（${state.mode === 'standard' ? '标准推荐固定权重' : '按我的偏好权重'}）。通勤细分：${COMMUTE_SUBS.map((s) => `${s.label} ${c.commuteParts[s.key]}分×${c.subC[s.key]}%`).join('，')}。生活细分：${LIFE_SUBS.map((s) => `${s.label} ${c.lifeParts[s.key]}分×${c.subL[s.key]}%`).join('，')}。</div>
    ${violations.length ? `<div class="se-violations">底线问题：${violations.map((v) => v.text).join('；')}</div>` : ''}
    <div class="se-note">评分仅用于辅助决策，不构成房产、教育或入学承诺。</div>`;
}

/* ---------- 完整数据表 ---------- */
function renderTable() {
  const order = currentOrder();
  const w = state.weights;
  const relPill = (kind) => {
    const r = MODE_KIND[kind].rel;
    return `<span class="pill ${r === '稳定' ? 'pill-green' : r === '一般' ? 'pill-orange' : 'pill-red'}">${r}</span>`;
  };
  $('#compareTable').innerHTML = `
    <thead><tr>
      <th>房源</th><th>状态</th><th>标准排名</th><th>偏好排名</th><th>综合适配分</th>
      <th>实际月支出</th><th>综合月成本</th><th>推荐方式</th><th>常规/保守通勤</th>
      <th>最晚出发</th><th>可靠性</th><th>配套摘要</th>
    </tr></thead>
    <tbody>${order.map((c) => {
      const letter = String.fromCharCode(65 + c.idx);
      const delta = state.stdRanks[c.id] - state.personalRanks[c.id];
      const deltaHtml = delta > 0 ? `<span class="rank-delta rank-up">↑${delta}</span>`
        : delta < 0 ? `<span class="rank-delta rank-down">↓${-delta}</span>`
        : '<span class="rank-delta rank-same">—</span>';
      const st = STATUS_META[c.status];
      const nearList = Object.entries(c.amenities)
        .filter(([, a]) => a && amenityRange(a) <= 3)
        .sort((x, y) => x[1].dist - y[1].dist).slice(0, 3)
        .map(([k, a]) => `${AMENITY_META[k].label} ${a.dist}km`).join(' · ');
      return `
      <tr class="${c.status === 'ineligible' ? 'ineligible' : ''}">
        <td><span class="num-tag" style="background:${LISTING_COLORS[c.idx % LISTING_COLORS.length]}">${letter}</span>
          <span class="cell-name">${c.name}</span>
          <div class="cell-sub">${c.address}</div>
          <div class="cell-sub">¥${fmtMoney(c.rent)}/月 · ${c.area}㎡ · ${c.layout} · ${c.rentType} · ${c.bath}</div></td>
        <td><span class="pill ${st.cls}">${st.text}</span>
          ${c.checks.filter((x) => x.sev !== 'ok').map((x) => `<div class="cell-sub" style="color:var(--risk)">${x.text}</div>`).join('')}</td>
        <td><span class="rank-cell">第 ${state.stdRanks[c.id]} 名</span></td>
        <td><span class="rank-cell">第 ${state.personalRanks[c.id]} 名</span>${deltaHtml}</td>
        <td><span class="cell-num">${scoreOf(c, w)}<span class="unit"> 分</span></span><br>
          <button class="link-btn" data-exp="${c.id}">查看评分说明</button></td>
        <td><span class="cell-num">${fmtMoney(c.actual)}<span class="unit"> 元/月</span></span>
          <div class="cell-sub">占预算 ${state.budget ? Math.round(c.actual / state.budget * 100) : '-'}%</div></td>
        <td><span class="cell-num">${fmtMoney(c.total)}<span class="unit"> 元/月</span></span>
          <div class="cell-sub">含交通费 ${transitMonthly(c.rec)} 元</div></td>
        <td><span class="pill pill-blue">${TRANSPORT_LABEL[c.rec.mode]}</span>
          <div class="cell-sub">${MODE_KIND[c.rec.kind].label} · 换乘 ${c.rec.transfers} 次</div></td>
        <td><span class="cell-num">${c.rec.duration} / ${c.rec.cons}<span class="unit"> 分钟</span></span></td>
        <td><span class="depart-cell">${fmtTime(c.departMin)}</span></td>
        <td>${relPill(c.rec.kind)}</td>
        <td><div class="cell-sub">${nearList || '3km 内配套较少'}</div></td>
      </tr>
      <tr class="hidden" data-exprow="${c.id}"><td colspan="12">
        <div class="score-explain open"><div class="se-body">${scoreExplainHtml(c)}</div></div>
      </td></tr>`;
    }).join('')}
    </tbody>`;
}

/* ---------- 排名差异 ---------- */
function diffReason(c) {
  const pw = normalize100(personalRawWeights());
  const changed = DIMS.map((d) => ({ d, delta: pw[d.key] - STD_WEIGHTS[d.key] }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  if (Math.abs(changed.delta) < 1) return '两种模式权重一致，排名相同';
  const s = c.dimScores[changed.d.key];
  const dir = changed.delta > 0 ? '权重上升' : '权重下降';
  const quality = s >= 70 ? '该房源此维度表现较好' : s >= 50 ? '该房源此维度表现中等' : '该房源此维度偏弱';
  return `因为你调整了「${changed.d.label}」的${dir.replace('权重', '权重（')}${changed.delta > 0 ? '' : ''}${STD_WEIGHTS[changed.d.key]}% → ${pw[changed.d.key]}%），${quality}（${s} 分）`;
}
function renderDiff() {
  const rows = [...state.computed].sort((a, b) => state.stdRanks[a.id] - state.stdRanks[b.id]);
  $('#diffList').innerHTML = rows.map((c) => {
    const d = state.stdRanks[c.id] - state.personalRanks[c.id];
    const arrow = d > 0 ? `<span class="di-arrow rank-up">↑ ${d}</span>`
      : d < 0 ? `<span class="di-arrow rank-down">↓ ${-d}</span>`
      : '<span class="di-arrow rank-same">—</span>';
    return `<div class="diff-item">
      <span class="di-name">房源 ${String.fromCharCode(65 + c.idx)} · ${c.name}</span>
      <span class="di-ranks">标准推荐 #${state.stdRanks[c.id]} → 我的偏好 #${state.personalRanks[c.id]}</span>
      ${arrow}
      <span class="di-reason">${d === 0 ? '排名未变' : diffReason(c)}</span>
    </div>`;
  }).join('');
}

/* ---------- 单房源详情 ---------- */
function renderDetails() {
  const box = $('#detailContainer');
  box.innerHTML = '';
  currentOrder().forEach((c) => {
    const open = !!state.collapsed[c.id];
    const letter = String.fromCharCode(65 + c.idx);
    const st = STATUS_META[c.status];
    const card = document.createElement('div');
    card.className = 'detail-card' + (c.status === 'ineligible' ? ' ineligible' : '');
    card.dataset.listingId = c.id; // 供 AI 引用卡片定位高亮

    const commuteNotice = c.rec.unsuitable ? `
      <div class="commute-warning">
        该房源暂无适合作为日常上班的通勤方案。最快可行方式为${TRANSPORT_LABEL[c.rec.mode]}：保守通勤 ${c.rec.cons} 分钟，建议 ${fmtTime(c.departMin)} 出发。<br>
        建议：放宽通勤上限；调整公司地址或到达时间；或将该房源从优先候选中排除。
      </div>` : '';

    const commuteHtml = TRANSPORT_MODES.map((m) => {
      const opt = c.commute[m];
      // 规则六：无效路线（夜班/异常/待核验）不展示 P50/P90，只显示明确的无效原因
      if (opt.invalid) {
        return `<div class="commute-opt invalid">
          <span class="rec-mark warn">不纳入推荐</span>
          <div class="co-head"><span class="co-mode">${TRANSPORT_LABEL[m]}</span></div>
          <div class="co-route">暂未获得适合工作日早高峰的有效路线。${opt.invalidReason}</div>
        </div>`;
      }
      const cons = modeConservative(m, opt);
      const depart = parseTime(state.arriveTime) - cons;
      const kind = MODE_KIND[opt.kind];
      const ev = c.rec.evals ? c.rec.evals[m] : null;
      const feasible = ev ? ev.feasible : true;
      const isRec = m === c.rec.mode && !c.rec.unsuitable;
      const relCls = kind.rel === '稳定' ? 'pill-green' : kind.rel === '一般' ? 'pill-orange' : 'pill-red';
      const dailyFee = Math.round(kind.fee * 2);

      // 不适合日常通勤的步行：折叠为参考信息，不与地铁/驾车并列推荐
      if (m === 'walk' && !feasible) {
        return `<div class="commute-opt folded">其他方式（不适合日常通勤）：步行 ${opt.distance} 公里，预计 ${opt.duration} 分钟，仅供距离参考。</div>`;
      }

      let mark = '';
      if (isRec) mark = '<span class="rec-mark">推荐</span>';
      else if (!feasible) mark = `<span class="rec-mark warn">${m === 'bike' ? '较长骑行' : '不适合日常通勤'}</span>`;

      let note = '';
      if (ev && ev.prefException) {
        note = `<div class="co-note">该路线${TRANSPORT_LABEL[m]} ${opt.duration} 分钟、${opt.distance} 公里，属于长距离日常${TRANSPORT_LABEL[m]}；仅因你开启${TRANSPORT_LABEL[m]}优先而纳入推荐，请注意天气、体力和安全风险。</div>`;
      } else if (isRec && m === 'drive') {
        note = '<div class="co-note">驾车更快，但早高峰波动较大</div>';
      } else if (!feasible) {
        note = `<div class="co-note">${m === 'bike' ? '不建议作为默认日常上班方式' : '不满足日常通勤可行性'}${ev && ev.fails.length ? `（${ev.fails.join('；')}）` : ''}</div>`;
      }

      return `
        <div class="commute-opt ${isRec ? 'recommended' : ''}">
          ${mark}
          <div class="co-head">
            <span class="co-mode">${TRANSPORT_LABEL[m]}（${kind.label}）</span>
            <span class="pill ${relCls}">${kind.rel}</span>
            ${opt.transfers ? `<span class="pill pill-blue">换乘 ${opt.transfers} 次</span>` : '<span class="pill pill-blue">无需换乘</span>'}
          </div>
          <div class="co-stats">
            <span>常规(P50) <b>${opt.duration}</b> 分钟</span>
            <span>保守(P90+缓冲) <b>${cons}</b> 分钟</span>
            <span>建议 <b>${fmtTime(depart)}</b> 出发</span>
            <span><b>${opt.distance}</b> 公里</span>
            <span><b>${dailyFee}</b> 元/天</span>
          </div>
          <div class="co-route">${opt.route}（缓冲：波动 ${kind.buffer} + 到楼 ${ARRIVAL_BUFFER} 分钟）</div>
          ${note}
        </div>`;
    }).join('');

    const ranges = [1, 3, 5];
    const rangeHtml = ranges.map((r) => `
      <div class="range-panel ${r === 1 ? '' : 'hidden'}" data-range="${r}" data-lid="${c.id}">
        <div class="amenity-list">
          ${Object.keys(AMENITY_META).map((k) => {
            const a = c.amenities[k];
            const inRange = a && amenityRange(a) <= r;
            const st2 = amenityStatus(inRange ? a : null);
            return `<div class="amenity-item">
              <div class="a-info"><b>${AMENITY_META[k].label}</b>
              <span>${inRange ? `${a.name} · ${a.dist}km · 步行约${a.walkMin}分钟 / 驾车约${a.driveMin}分钟` : `${r}km 范围内暂无`}</span></div>
              <span class="pill ${st2.cls}">${st2.text}</span>
            </div>`;
          }).join('')}
        </div>
      </div>`).join('');

    const ex = ruleExplain(c);
    card.innerHTML = `
      <div class="detail-head" data-toggle="${c.id}">
        <h3><span class="num-tag" style="background:${LISTING_COLORS[c.idx % LISTING_COLORS.length]}">${letter}</span>${c.name}
          <span class="pill ${st.cls}">${st.text}</span></h3>
        <span class="collapse-icon">${open ? '收起 ▲' : '展开 ▼'}</span>
      </div>
      <div class="detail-body ${open ? '' : 'hidden'}">
        <div class="rule-explain">
          <div class="re-title">${ex.title}</div>
          <ul>${ex.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
        </div>
        <details class="score-explain">
          <summary>查看评分说明（各维度得分 × 权重）</summary>
          <div class="se-body">${scoreExplainHtml(c)}</div>
        </details>
        <div class="detail-grid" style="margin-top:18px">
          <div>
            <div class="module-title">通勤方案（${state.arriveTime} 到达 · 含可靠性缓冲）</div>
            ${commuteNotice}
            ${commuteHtml}
          </div>
          <div>
            <div class="module-title">周边配套（高德 POI 实时搜索）</div>
            <div class="range-tabs" data-tabs="${c.id}">
              ${ranges.map((r) => `<button class="range-tab ${r === 1 ? 'active' : ''}" data-r="${r}">${r} km 内</button>`).join('')}
            </div>
            ${rangeHtml}
          </div>
        </div>
      </div>`;
    box.appendChild(card);
  });
}

/* ---------- 结果页汇总 ---------- */
function renderResult() {
  computeAll();
  document.querySelectorAll('#modeSwitch .mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });
  $('#resetModeBtn').classList.toggle('hidden', state.mode !== 'personal');
  renderHero();
  renderPicks();
  renderHcards();
  renderTable();
  renderDiff();
  renderDetails();
  // 生成选房报告 → 保存报告快照并自动保存方案
  const ranks = currentRanks();
  const top = currentOrder().find((c) => c.status !== 'ineligible');
  state.reportSnapshot = {
    generatedAt: new Date().toISOString(),
    recommendedListingId: top ? top.id : undefined,
    recommendedListingName: top ? top.name : undefined,
    results: state.computed.map((c) => ({
      id: c.id, name: c.name, status: c.status,
      rank: ranks[c.id], score: scoreOf(c, state.weights),
    })),
  };
  scheduleSave();
}

/* =========================================================
 * AI 选房助手 · 真实数据适配器
 * 只读 state.computed（页面已有的评分/通勤/硬约束结果是唯一事实来源），
 * 整理为可 JSON 序列化的精简快照，供 AI 接口的 Tool 查询，不参与任何计算。
 * ========================================================= */
const AMENITY_LABEL = {
  metro: '地铁站', hema: '盒马鲜生', aldi: '奥乐齐', sam: '山姆会员店',
  rt: '大润发', market: '菜市场', hospital: '医院', school: '小学', park: '公园',
};
const SEV_LABEL = { ok: '满足', minor: '轻微超出', major: '不满足' };

function assistantListing(c) {
  const ranks = currentRanks();
  const amenities = {};
  Object.entries(c.amenities || {}).forEach(([k, v]) => {
    if (!v) return;
    amenities[k] = { name: v.name, distKm: Math.round(v.dist * 10) / 10, walkMin: v.walkMin };
  });
  return {
    id: c.id,
    letter: String.fromCharCode(65 + c.idx), // 房源 A/B/C…
    name: c.name,
    address: c.address,
    rent: c.rent,
    area: c.area,
    layout: c.layout,
    floor: c.floor,
    facing: c.facing,
    rentType: c.rentType,
    note: c.note || '',
    rank: ranks[c.id],
    score: scoreOf(c, state.weights),
    status: c.status, // eligible / conditional / ineligible
    statusLabel: STATUS_META[c.status].text,
    dimScores: c.dimScores,
    monthlyCost: c.actual,          // 租金 + 估算水电物业
    totalMonthlyCost: c.total,      // 再 + 通勤月费用
    commute: {
      mode: c.rec.mode,
      modeLabel: TRANSPORT_LABEL[c.rec.mode],
      conservativeMinutes: c.rec.cons,
      durationMinutes: c.rec.duration,
      distanceKm: c.rec.distance,
      transfers: c.rec.transfers,
      latestDeparture: fmtTime(c.departMin),
      unsuitable: !!c.rec.unsuitable,
    },
    station: c.station
      ? { name: c.station.name, walkMeters: c.station.walk, walkMin: c.station.walkMin }
      : null,
    amenities,
    hardConstraintResults: (c.checks || []).map((ch) => ({
      label: ch.label, result: SEV_LABEL[ch.sev] || ch.sev, detail: ch.text,
    })),
    dataStatus: 'ok',
  };
}

/* 当前页面真实计算结果 → AI 上下文（最多 5 套，按当前排名排序） */
function buildAssistantContext() {
  if (!state.computed.length) computeAll();
  const order = currentOrder().slice(0, 5);
  const listings = order.map(assistantListing);
  // 高德数据加载失败、未参与评分的房源也告知 AI（标记待核验，不编造其数据）
  state.listings.forEach((l) => {
    if (l._failed && listings.length < 5) {
      listings.push({
        id: l.id, name: l.name, address: l.address, rent: l.rent, area: l.area,
        layout: l.layout, dataStatus: 'pending_verification',
      });
    }
  });
  return {
    company: state.company,
    budget: state.budget,
    arriveTime: state.arriveTime,
    mode: state.mode === 'standard' ? '标准推荐' : '按我的偏好',
    weights: { ...state.weights },
    dataFetchedAt: state.dataFetchedAt,
    listings,
  };
}
window.getAssistantContext = buildAssistantContext;

/* 引用卡片点击 → 定位并高亮结果页对应房源详情 */
window.highlightListing = function (id) {
  const card = document.querySelector(`[data-listing-id="${id}"]`);
  if (!card) return;
  state.collapsed[id] = true; // 展开详情
  card.querySelector('.detail-body')?.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('ai-highlight');
  setTimeout(() => card.classList.remove('ai-highlight'), 2400);
};

/* =========================================================
 * 事件绑定与初始化
 * ========================================================= */
function bindEvents() {
  // 视图导航（所有 data-goto）
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-goto]');
    if (nav) showView(nav.dataset.goto);
  });
  $('#startBtn').addEventListener('click', () => showView('step1'));

  // 第 1 步：基础信息
  $('#companyInput').addEventListener('input', (e) => {
    state.company = e.target.value || '公司';
    state._companyGeo = null; // 公司变更后，进入第 2 步会重新地理编码并刷新通勤数据
    scheduleSave();
  });
  $('#arriveTime').addEventListener('input', (e) => {
    state.arriveTime = e.target.value || '09:00';
    // 到达时间变化 → 未来路线规划缓存失效，下次进入第 2 步时按新时刻重查
    state.listings.forEach((l) => { l._futureSig = null; });
    scheduleSave();
  });
  $('#prefTransportCaps').addEventListener('click', (e) => {
    const btn = e.target.closest('.capsule');
    if (!btn) return;
    state.prefTransport = btn.dataset.pt;
    document.querySelectorAll('#prefTransportCaps .capsule').forEach((b) => b.classList.toggle('active', b === btn));
    scheduleSave();
  });

  // 第 1 步：底线条件
  $('#constraintGrid').addEventListener('click', (e) => {
    const segBtn = e.target.closest('.seg button');
    if (segBtn) {
      const key = segBtn.parentElement.dataset.ckey;
      state.constraints[key].lv = Number(segBtn.dataset.lv);
      renderConstraints();
      scheduleSave();
      return;
    }
    const capBtn = e.target.closest('[data-ccaps] button');
    if (capBtn) {
      const key = capBtn.closest('[data-ccaps]').dataset.ccaps;
      const v = Number(capBtn.dataset.v);
      if (key === 'budget') state.budget = v;
      else state.constraints[key].val = v;
      renderConstraints();
      scheduleSave();
    }
  });
  $('#constraintGrid').addEventListener('input', (e) => {
    const key = e.target.dataset.cval;
    if (!key) return;
    if (key === 'budget') state.budget = Number(e.target.value) || 0;
    else {
      const c = CONSTRAINTS.find((x) => x.key === key);
      state.constraints[key].val = c.type === 'number' ? Number(e.target.value) : e.target.value;
    }
    renderBottomline();
    scheduleSave();
  });

  // 第 2 步：房源卡片
  $('#listingList').addEventListener('input', (e) => {
    const id = Number(e.target.dataset.id), f = e.target.dataset.f;
    if (!id || !f) return;
    const l = state.listings.find((x) => x.id === id);
    l[f] = (f === 'rent' || f === 'area') ? Number(e.target.value) : e.target.value;
    scheduleSave();
  });
  $('#listingList').addEventListener('change', (e) => {
    // 地址变化 → 重新走高德地理编码并刷新通勤/配套（无模拟数据，地址为空则等待填写）
    const id = Number(e.target.dataset.id), f = e.target.dataset.f;
    if (id && f === 'address') {
      const l = state.listings.find((x) => x.id === id);
      if (l) {
        l._realSig = null;
        l._failed = false;
        if (l.address.trim()) {
          setMapLoading(true);
          ensureRealData().then(() => {
            setMapLoading(false);
            computeAll(); renderListingCards(); mapFocusSelected(); renderMap(); renderDataState();
            scheduleSave(); // 路线/POI 数据更新后自动保存
          });
          return;
        }
      }
    }
    computeAll(); renderListingCards(); renderMap();
    scheduleSave();
  });
  $('#listingList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (state.listings.length <= 2) return;
      const id = Number(del.dataset.del);
      state.listings = state.listings.filter((l) => l.id !== id);
      if (state.selectedId === id) state.selectedId = state.listings[0].id;
      computeAll(); renderListingCards(); renderMap(); mapFitAll();
      scheduleSave();
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel && !e.target.closest('input, select, textarea')) {
      state.selectedId = Number(sel.dataset.select);
      renderListingCards();
      renderMap();
      mapFocusSelected();
    }
  });
  $('#addListingBtn').addEventListener('click', () => {
    if (state.listings.length >= 5) return;
    const id = state.nextId++;
    state.listings.push({
      id, name: `新房源 ${String.fromCharCode(64 + state.listings.length + 1)}`,
      address: '', rent: 6500, area: 55,
      layout: '1室1厅', floor: '5/12层', facing: '南', rentType: '整租', bath: '独卫', note: '',
    });
    state.selectedId = id;
    computeAll(); renderListingCards(); // 填写地址后由 change 事件触发真实数据拉取
    scheduleSave();
  });

  // 第 2 步：地图控件
  $('#mapModes').addEventListener('click', (e) => {
    const btn = e.target.closest('.map-mode');
    if (!btn) return;
    state.mapMode = btn.dataset.mm;
    renderMap();
    mapFitAll(); // 切换方式后保持 A/B/C 与公司全部可见，同时画出选中房源的路线
  });
  $('#mapZoomIn').addEventListener('click', () => { if (amapMap) amapMap.zoomIn(); });
  $('#mapZoomOut').addEventListener('click', () => { if (amapMap) amapMap.zoomOut(); });
  $('#mapFit').addEventListener('click', () => { renderMap(); mapFitAll(); });

  // 第 3 步：偏好卡片墙
  $('#prefWall').addEventListener('click', (e) => {
    const btn = e.target.closest('.pref-card');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.pref;
    state.selectedPrefs = state.selectedPrefs.includes(key)
      ? state.selectedPrefs.filter((k) => k !== key)
      : [...state.selectedPrefs, key];
    state.customTopWeights = null;
    renderPrefWall(); renderPrefProfile(); renderSliders();
    scheduleSave();
  });

  // 第 3 步：模式卡片
  $('#modeCards').addEventListener('click', (e) => {
    const card = e.target.closest('.mode-card');
    if (!card) return;
    state.mode = card.dataset.mode;
    renderModeCards();
    scheduleSave();
  });

  // 高级设置
  $('#advToggle').addEventListener('click', () => {
    const el = $('#advPanel');
    el.classList.toggle('hidden');
    $('#advToggle').textContent = el.classList.contains('hidden') ? '高级设置：微调权重 ▾' : '收起高级设置 ▴';
  });
  $('#advPanel').addEventListener('input', (e) => {
    const type = e.target.dataset.slider, key = e.target.dataset.key;
    if (!type) return;
    const v = Number(e.target.value);
    if (type === 'top') {
      if (!state.customTopWeights) state.customTopWeights = personalRawWeights();
      state.customTopWeights[key] = v;
      const norm = normalize100(state.customTopWeights);
      DIMS.forEach((d) => {
        const el = document.querySelector(`[data-sv="top-${d.key}"]`);
        if (el) el.textContent = `${norm[d.key]}%`;
      });
    } else {
      const subs = type === 'commute' ? COMMUTE_SUBS : LIFE_SUBS;
      const store = type === 'commute' ? state.commuteSub : state.lifeSub;
      store[key] = v;
      const norm = type === 'commute' ? effectiveCommuteSub() : effectiveLifeSub();
      subs.forEach((s) => {
        const el = document.querySelector(`[data-sv="${type}-${s.key}"]`);
        if (el) el.textContent = `${norm[s.key]}%`;
      });
    }
    scheduleSave();
  });

  // 结果页：模式切换
  $('#modeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    renderResult();
  });
  $('#resetModeBtn').addEventListener('click', () => {
    state.mode = 'standard';
    state.selectedPrefs = [];
    state.customTopWeights = null;
    state.commuteSub = Object.fromEntries(COMMUTE_SUBS.map((s) => [s.key, s.def]));
    state.lifeSub = Object.fromEntries(LIFE_SUBS.map((s) => [s.key, s.def]));
    renderResult();
  });

  // 完整数据展开
  $('#fullDataBtn').addEventListener('click', () => {
    const el = $('#fullData');
    el.classList.toggle('hidden');
    $('#fullDataBtn').textContent = el.classList.contains('hidden') ? '查看完整数据 ▾' : '收起完整数据 ▴';
  });
  $('#compareTable').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-exp]');
    if (!btn) return;
    document.querySelector(`[data-exprow="${btn.dataset.exp}"]`)?.classList.toggle('hidden');
  });

  // 详情折叠 + 配套范围切换
  $('#detailContainer').addEventListener('click', (e) => {
    const head = e.target.closest('[data-toggle]');
    if (head) {
      const id = Number(head.dataset.toggle);
      state.collapsed[id] = !state.collapsed[id];
      renderDetails();
      return;
    }
    const tab = e.target.closest('.range-tab');
    if (tab) {
      const lid = tab.parentElement.dataset.tabs;
      tab.parentElement.querySelectorAll('.range-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll(`.range-panel[data-lid="${lid}"]`).forEach((p) => {
        p.classList.toggle('hidden', p.dataset.range !== tab.dataset.r);
      });
    }
  });

  // AI 面板（React Island）：结果页「向 AI 追问」按钮 → 通知面板打开
  $('#aiOpenBtn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('zhunaer:open-assistant'));
  });

  // 我的方案抽屉
  $('#projBtn').addEventListener('click', openDrawer);
  $('#pdClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  $('#pdNew').addEventListener('click', createProject);
  $('#pdImport').addEventListener('click', () => $('#pdImportFile').click());
  $('#pdImportFile').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importProjectFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#pdList').addEventListener('click', (e) => {
    const opBtn = e.target.closest('[data-op]');
    if (!opBtn) return;
    const card = opBtn.closest('[data-pid]');
    const id = card.dataset.pid;
    const op = opBtn.dataset.op;
    if (op === 'open') openProject(id);
    else if (op === 'rename') renameProject(id);
    else if (op === 'dup') duplicateProject(id);
    else if (op === 'export') exportProject(id);
    else if (op === 'del') deleteProject(id);
  });

  // 保存失败时点击状态文字重试
  $('#saveStatus').addEventListener('click', () => {
    if ($('#saveStatus').classList.contains('error')) saveNow();
  });

  // 关闭/刷新页面前，把待保存的修改立即落盘
  window.addEventListener('beforeunload', () => { if (saveTimer) saveNow(); });
}

/* ---------- 初始化 ---------- */
initProjects(); // 恢复最近编辑的方案，或创建默认「未命名选房方案」
renderConstraints();
bindEvents();
