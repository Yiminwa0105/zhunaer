/* =========================================================
 * 住哪儿 · 标准推荐与个性化偏好决策系统（Demo，全部模拟数据）
 * 模型：硬约束 + 可解释加权评分 + 通勤可靠性（保守通勤时间）
 * 地图：MockMapProvider / RouteProvider 模拟实现，
 *       接入真实地图 API 时仅替换这两个 Provider，评分引擎不变。
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

/* ---------- 通勤可靠性规则（模拟 P90） ----------
 * 保守通勤时间 = 常规时间(P50) + 方式缓冲 + 10 分钟到楼/打卡缓冲 */
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

/* ---------- MapProvider / RouteProvider（模拟实现） ----------
 * 职责：地理编码、路线几何、站点数据。评分引擎只消费返回的结构化事实数据。
 * 接入高德/百度/腾讯地图时，仅需用真实实现替换这两个对象。 */
const MockMapProvider = {
  // 虚拟坐标系 1000×640，模拟上海陆家嘴及周边
  companyCoord: { x: 660, y: 290 },
  geocode(address, salt = 0) {
    let h = 0;
    const s = String(address) + '|' + salt;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return { x: 110 + (h % 780), y: 80 + ((h >>> 9) % 480) };
  },
};
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const RouteProvider = {
  // 返回：路径点、关键站点/换乘点、距离、时长、换乘次数
  plan(from, to, mode, opt) {
    const points = [];
    const stops = [];
    if (mode === 'transit') {
      const s1 = lerp(from, to, 0.16);
      const mid = lerp(from, to, 0.55); mid.y -= 30;
      points.push(from, s1, mid, to);
      stops.push({ p: s1, label: '进站' });
      if (opt.transfers > 0) stops.push({ p: mid, label: '换乘' });
    } else {
      const mid = lerp(from, to, 0.5);
      mid.x += mode === 'drive' ? 40 : 16;
      mid.y -= mode === 'drive' ? 26 : 10;
      points.push(from, mid, to);
    }
    return {
      points, stops,
      distance: opt.distance, duration: opt.duration,
      transfers: opt.transfers, kind: opt.kind,
      dailyFee: Math.round(MODE_KIND[opt.kind].fee * 2),
    };
  },
};

/* =========================================================
 * 高德真实地图 Provider（JS API 2.0）
 * 数据获取成功后写入与模拟数据完全一致的结构，评分引擎无感知；
 * 任何一步失败都会保留该房源的模拟数据兜底，页面不会崩。
 * ========================================================= */
const USE_AMAP = typeof window.AMap !== 'undefined';
// 「未来路线规划」Worker 代理地址（Cloudflare Worker，见 worker.js）。
// 部署后填入，例如 'https://zhunaer-etd-proxy.你的账号.workers.dev/etd'；
// 本地调试填 'http://localhost:8787/etd'；留空则不启用，自动使用缓冲模型。
// 本地开发用 wrangler dev 的本地代理（workers.dev 域名在国内网络不可达，线上需绑自定义域名）
const FUTURE_ROUTE_API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://127.0.0.1:8787/etd'
  : 'https://zhunaer-etd-proxy.yiminwa0105.workers.dev/etd';
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

function amapRoute(from, to, mode, city) {
  return new Promise((resolve) => {
    const fail = () => resolve(null);
    try {
      const origin = [from.lng, from.lat], dest = [to.lng, to.lat];
      if (mode === 'transit') {
        new AMap.Transfer({ city }).search(origin, dest, (status, result) => {
          if (status !== 'complete' || !result.plans || !result.plans.length) return fail();
          const p = result.plans[0];
          const lines = [], path = [];
          (p.segments || []).forEach((seg) => {
            if (seg.transit && seg.transit.lines && seg.transit.lines.length) {
              lines.push(String(seg.transit.lines[0].name).replace(/\(.*?\)/g, ''));
            }
            const segPath = (seg.transit && seg.transit.path)
              || (seg.walking && seg.walking.path)
              || ((seg.walking && seg.walking.steps) || []).flatMap((s) => s.path || []);
            (segPath || []).forEach((pt) => path.push(pt));
          });
          const transfers = Math.max(0, lines.length - 1);
          resolve({
            duration: Math.round(p.time / 60),
            distance: Math.round((p.distance / 1000) * 10) / 10,
            kind: transfers > 0 ? 'metro_transfer' : 'metro_direct',
            transfers,
            route: lines.length
              ? `乘坐 ${lines.join(' → ')}${transfers ? `，换乘 ${transfers} 次` : '，无需换乘'}（高德实时规划）`
              : `公交方案全程约 ${(p.distance / 1000).toFixed(1)} 公里（高德实时规划）`,
            path: path.length >= 2 ? path : null,
          });
        });
      } else {
        const Svc = { drive: AMap.Driving, walk: AMap.Walking, bike: AMap.Riding }[mode];
        new Svc().search(origin, dest, (status, result) => {
          if (status !== 'complete' || !result.routes || !result.routes.length) return fail();
          const r = result.routes[0];
          const path = [];
          const steps = r.steps || (r.rides && r.rides[0] && r.rides[0].steps) || [];
          steps.forEach((s) => (s.path || []).forEach((pt) => path.push(pt)));
          resolve({
            duration: Math.round(r.time / 60),
            distance: Math.round((r.distance / 1000) * 10) / 10,
            kind: mode, transfers: 0,
            route: `${TRANSPORT_LABEL[mode]}全程约 ${(r.distance / 1000).toFixed(1)} 公里（高德实时规划）`,
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

/* 真实经纬度 → 虚拟坐标（供结果页小地图与模拟兜底渲染复用） */
function lnglatToVirtual(g) {
  const c = state._companyGeo ? state._companyGeo.lnglat : g;
  const x = 660 + (g.lng - c.lng) * 5500 * Math.cos((c.lat * Math.PI) / 180);
  const y = 290 - (g.lat - c.lat) * 6400;
  return { x: clamp(Math.round(x), 40, 960), y: clamp(Math.round(y), 40, 600) };
}

/* 预取真实数据：公司/房源地理编码 → 4 种通勤 → 周边 POI。
 * 以「房源地址+公司地址」为签名做缓存，未变化时不重复请求。 */
async function ensureRealData() {
  if (!USE_AMAP) return false;
  if (!state._companyGeo || state._companyGeo.addr !== state.company) {
    try {
      const g = await amapGeocode(state.company);
      state._companyGeo = { addr: state.company, lnglat: g };
      if (g.city) state._companyCity = g.city;
    } catch (e) {
      console.warn('[住哪儿] 公司地址解析失败，使用模拟地图兜底', e);
      return state.usingReal;
    }
  }
  const company = state._companyGeo.lnglat;
  for (const l of state.listings) {
    const sig = `${l.address}|${state.company}`;
    if (l._realSig === sig) continue;
    try {
      if (!l._geo || l._geo.addr !== l.address) {
        const g = await amapGeocode(l.address);
        l._geo = { addr: l.address, lnglat: g };
        l.lnglat = g;
        l.coord = lnglatToVirtual(g);
      }
      for (const m of TRANSPORT_MODES) {
        const r = await amapRoute(l.lnglat, company, m, state._companyCity);
        if (r) {
          l.commute[m] = { duration: r.duration, distance: r.distance, kind: r.kind, transfers: r.transfers, route: r.route };
          l._paths = l._paths || {};
          l._paths[m] = r.path;
        }
      }
      for (const [key, kw] of POI_QUERIES) {
        const poi = await amapPoi(kw, l.lnglat);
        l.amenities[key] = poi;
        if (key === 'metro' && poi) {
          l.station = { name: poi.name, walk: Math.round(poi.dist * 1000), walkMin: poi.walkMin };
        }
      }
      l._realSig = sig;
    } catch (e) {
      console.warn('[住哪儿] 房源真实数据获取失败，保留模拟数据', l.address, e);
    }
  }
  // 未来路线规划：用「到达时间 − 缓冲」倒推出发时刻，查询该时刻的同时段驾车时长。
  // 以「地址+公司+到达时间」为缓存签名，到达时间变化时自动重查，失败保持缓冲模型结果。
  if (FUTURE_ROUTE_API) {
    const futSigOf = (l) => `${l.address}|${state.company}|${state.arriveTime}`;
    for (const l of state.listings) {
      if (!l.lnglat || !l.commute.drive || l._futureSig === futSigOf(l)) continue;
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
  state.usingReal = true;
  return true;
}

function initAmapMap() {
  if (amapMap || !USE_AMAP) return;
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
    // 路线：只画选中房源的路线（点击图钉切换）
    if (sel) {
      const path = (l._paths && l._paths[state.mapMode])
        || [[l.lnglat.lng, l.lnglat.lat], [company.lng, company.lat]];
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
      renderListingCards(); mapFocusSelected(); renderMap();
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
  if (badge) badge.textContent = state.usingReal ? '高德真实数据' : 'Demo 模拟数据';
  const tag = document.querySelector('.map-tag');
  if (tag) tag.textContent = state.usingReal
    ? '真实地图 · 高德地图 JS API（评分引擎不变）'
    : '模拟地图 · 可替换为高德/百度/腾讯 MapProvider';
}

/* ---------- 预置模拟房源（上海示例数据，作为真实数据的兜底） ---------- */
function seedListings() {
  return [
    {
      id: 1, name: '徐汇滨江一居室', address: '上海市徐汇区龙兰路 399 弄',
      rent: 7200, area: 52, layout: '1室1厅', floor: '12/18层', facing: '南',
      rentType: '整租', bath: '独卫', note: '近滨江步道，小区较新',
      coord: { x: 380, y: 430 },
      commute: {
        transit: { duration: 38, distance: 9.6,  kind: 'metro_transfer', transfers: 1, route: '步行 6 分钟至 11 号线龙耀路站 → 换乘 2 号线 → 陆家嘴站，共 9 站' },
        drive:   { duration: 32, distance: 11.8, kind: 'drive',          transfers: 0, route: '龙腾大道 → 内环高架 → 延安东路隧道，早高峰有拥堵风险' },
        bike:    { duration: 41, distance: 9.2,  kind: 'bike',           transfers: 0, route: '滨江骑行道 → 东昌路渡口方向，全程非机动车道约 80%' },
        walk:    { duration: 118, distance: 9.2, kind: 'walk',           transfers: 0, route: '全程步行约 9.2 公里，不推荐作为日常通勤方式' },
      },
      station: { name: '11 号线龙耀路站', walk: 450, walkMin: 6 },
      amenities: {
        metro:    { name: '11 号线龙耀路站',      dist: 0.45, walkMin: 6,  driveMin: 2 },
        hema:     { name: '盒马鲜生（徐汇滨江店）', dist: 0.8,  walkMin: 11, driveMin: 4 },
        aldi:     { name: '奥乐齐（龙华中路店）',   dist: 1.6,  walkMin: 22, driveMin: 7 },
        sam:      null,
        rt:       { name: '大润发（龙华店）',      dist: 2.8,  walkMin: 38, driveMin: 10 },
        market:   { name: '龙华菜市场',           dist: 1.1,  walkMin: 15, driveMin: 5 },
        hospital: { name: '龙华医院（三甲）',      dist: 2.2,  walkMin: 30, driveMin: 9 },
        school:   { name: '徐汇区龙华小学',        dist: 0.9,  walkMin: 12, driveMin: 4 },
        park:     { name: '徐汇滨江绿地',          dist: 0.3,  walkMin: 4,  driveMin: 2 },
      },
    },
    {
      id: 2, name: '静安大宁两居室', address: '上海市静安区灵石路 718 号',
      rent: 8600, area: 78, layout: '2室2厅', floor: '6/11层', facing: '南北',
      rentType: '整租', bath: '独卫', note: '近大宁公园，适合家庭',
      coord: { x: 330, y: 120 },
      commute: {
        transit: { duration: 47, distance: 13.4, kind: 'metro_transfer', transfers: 1, route: '步行 8 分钟至 1 号线上海马戏城站 → 人民广场换乘 2 号线 → 陆家嘴站，共 11 站' },
        drive:   { duration: 38, distance: 15.6, kind: 'drive',          transfers: 0, route: '共和新路高架 → 南北高架 → 延安东路隧道，早高峰拥堵明显' },
        bike:    { duration: 58, distance: 13.0, kind: 'bike',           transfers: 0, route: '灵石路 → 恒丰路 → 苏州河骑行道，距离较远' },
        walk:    { duration: 163, distance: 13.0, kind: 'walk',          transfers: 0, route: '全程步行约 13 公里，不推荐作为日常通勤方式' },
      },
      station: { name: '1 号线上海马戏城站', walk: 620, walkMin: 8 },
      amenities: {
        metro:    { name: '1 号线上海马戏城站',  dist: 0.62, walkMin: 8,  driveMin: 3 },
        hema:     { name: '盒马鲜生（大宁店）',   dist: 1.4,  walkMin: 19, driveMin: 6 },
        aldi:     { name: '奥乐齐（大宁国际店）', dist: 0.7,  walkMin: 10, driveMin: 3 },
        sam:      { name: '山姆会员店（宝山店）', dist: 4.6,  walkMin: 62, driveMin: 15 },
        rt:       { name: '大润发（闸北店）',     dist: 2.1,  walkMin: 28, driveMin: 8 },
        market:   { name: '灵石路菜市场',        dist: 0.4,  walkMin: 5,  driveMin: 2 },
        hospital: { name: '第十人民医院（三甲）', dist: 1.8,  walkMin: 24, driveMin: 7 },
        school:   { name: '大宁国际小学',        dist: 0.5,  walkMin: 7,  driveMin: 2 },
        park:     { name: '大宁灵石公园',        dist: 0.6,  walkMin: 8,  driveMin: 3 },
      },
    },
    {
      id: 3, name: '浦东三林一居室', address: '上海市浦东新区三林路 518 弄',
      rent: 5600, area: 48, layout: '1室1厅', floor: '3/6层', facing: '东南',
      rentType: '整租', bath: '独卫', note: '租金低，离前滩近',
      coord: { x: 600, y: 470 },
      commute: {
        transit: { duration: 33, distance: 7.8, kind: 'metro_transfer', transfers: 1, route: '步行 5 分钟至 11 号线三林站 → 东方体育中心换乘 6 号线，共 7 站' },
        drive:   { duration: 26, distance: 9.4, kind: 'drive',          transfers: 0, route: '济阳路 → 卢浦大桥 → 世纪大道，早高峰中度拥堵' },
        bike:    { duration: 34, distance: 7.5, kind: 'bike',           transfers: 0, route: '三林路 → 世博骑行道 → 东昌路，路况较好' },
        walk:    { duration: 95, distance: 7.5, kind: 'walk',           transfers: 0, route: '全程步行约 7.5 公里，不推荐作为日常通勤方式' },
      },
      station: { name: '11 号线三林站', walk: 380, walkMin: 5 },
      amenities: {
        metro:    { name: '11 号线三林站',      dist: 0.38, walkMin: 5,  driveMin: 2 },
        hema:     { name: '盒马鲜生（三林店）',  dist: 2.6,  walkMin: 35, driveMin: 9 },
        aldi:     null,
        sam:      { name: '山姆会员店（浦东店）', dist: 3.2,  walkMin: 43, driveMin: 11 },
        rt:       { name: '大润发（三林店）',     dist: 0.9,  walkMin: 12, driveMin: 4 },
        market:   { name: '三林塘菜市场',        dist: 0.6,  walkMin: 8,  driveMin: 3 },
        hospital: { name: '东方医院南院（三甲）', dist: 2.9,  walkMin: 39, driveMin: 10 },
        school:   { name: '三林镇中心小学',      dist: 1.2,  walkMin: 16, driveMin: 5 },
        park:     { name: '三林体育公园',        dist: 1.5,  walkMin: 20, driveMin: 6 },
      },
    },
  ];
}

/* ---------- 全局状态 ---------- */
const state = {
  view: 'welcome',
  company: '上海陆家嘴金融中心',
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
  mapView: { cx: 500, cy: 320, scale: 1 },
  collapsed: {},
  usingReal: false,            // 是否已切换到高德真实数据
  _companyGeo: null,           // 公司地理编码缓存 { addr, lnglat }
  _companyCity: '上海',
};

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

/* ---------- 通勤计算（消费 RouteProvider 结构化数据） ---------- */
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
  if (earliest.lv > 0 && departMin < parseTime(earliest.val)) {
    fails.push(`需 ${fmtTime(departMin)} 出发，早于你的底线 ${earliest.val}`);
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

  // 无合格方式：不推荐任何一种，仅取保守通勤最短的作为“最快可行方式”展示
  if (!feasibleModes.length) {
    const fastest = TRANSPORT_MODES.reduce((a, b) => (evals[a].cons <= evals[b].cons ? a : b));
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
function actualMonthly(l) { return l.rent + Math.round(l.area * 4); }                 // 租金 + 模拟水电物业
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
      return r === 5 ? { sev: 'minor', text: `学校较远（${c.amenities.school.dist}km）` } : { sev: 'major', text: '5km 内无学校（模拟数据）' };
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

  state.computed = state.listings.map((l, idx) => {
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
  $('#aiFab').classList.toggle('hidden', name !== 'result');
  // 进度条状态
  const idx = VIEW_ORDER.indexOf(name);
  document.querySelectorAll('.prog-item').forEach((el) => {
    const i = VIEW_ORDER.indexOf(el.dataset.goto);
    el.classList.toggle('current', i === idx);
    el.classList.toggle('done', i >= 0 && idx > i); // 首页等非步骤项不标记完成态
  });
  if (name === 'step2') {
    computeAll(); renderListingCards(); mapFitAll(); renderMap();
    if (USE_AMAP) {
      setMapLoading(true);
      ensureRealData().then((ok) => {
        setMapLoading(false);
        computeAll(); renderListingCards();
        if (ok) initAmapMap();
        mapFitAll(); renderMap(); updateDataBadge();
      });
    }
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
 * 第 2 步：房源卡片 + 模拟地图
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
      ${c ? `<div class="lc-depart">推荐：${fmtTime(c.departMin)} 出发 · 保守通勤 ${c.rec.cons} 分钟</div>` : ''}
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
      mapFocusSelected();
      renderMap();
    }
  });
}, { rootMargin: '-42% 0px -42% 0px' });

/* 为新增房源生成模拟数据（坐标走 MapProvider.geocode） */
function generateMockData(seed) {
  const rnd = (n) => { const x = Math.sin(seed * 9301 + n * 49297) * 233280; return x - Math.floor(x); };
  const dist = Math.round((5 + rnd(1) * 12) * 10) / 10;
  const t = Math.round(25 + rnd(2) * 35);
  const mk = (base, spread) => Math.round(base + rnd(3 + spread) * spread);
  const poi = (name, d2) => ({ name, dist: d2, walkMin: Math.max(2, Math.round(d2 * 13)), driveMin: Math.max(2, Math.round(2 + d2 * 2.2)) });
  const r1 = (k, base, span) => Math.round((base + rnd(k) * span) * 10) / 10;
  return {
    rentType: rnd(20) > 0.25 ? '整租' : '合租',
    bath: rnd(21) > 0.25 ? '独卫' : '公卫',
    commute: {
      transit: { duration: t, distance: dist, kind: rnd(22) > 0.4 ? 'metro_transfer' : 'metro_direct', transfers: rnd(22) > 0.4 ? 1 : 0, route: `步行 ${mk(4, 6)} 分钟至就近地铁站 → 陆家嘴方向（模拟路线）` },
      drive:   { duration: Math.max(15, t - mk(5, 10)), distance: Math.round((dist + 2) * 10) / 10, kind: 'drive', transfers: 0, route: '高架 + 隧道，早高峰存在拥堵（模拟路线）' },
      bike:    { duration: t + mk(0, 12), distance: Math.round((dist - 0.4) * 10) / 10, kind: 'bike', transfers: 0, route: '市政非机动车道为主（模拟路线）' },
      walk:    { duration: Math.round(dist * 12.5), distance: dist, kind: 'walk', transfers: 0, route: '全程步行，不推荐作为日常通勤方式（模拟路线）' },
    },
    station: { name: '就近地铁站（模拟）', walk: mk(300, 500), walkMin: mk(4, 6) },
    amenities: {
      metro:    poi('就近地铁站（模拟）', r1(4, 0.3, 0.9)),
      hema:     rnd(5) > 0.25 ? poi('盒马鲜生（模拟门店）', r1(6, 0.5, 4)) : null,
      aldi:     rnd(7) > 0.4 ? poi('奥乐齐（模拟门店）', r1(8, 0.6, 4)) : null,
      sam:      rnd(9) > 0.5 ? poi('山姆会员店（模拟门店）', r1(10, 2, 3)) : null,
      rt:       poi('大润发（模拟门店）', r1(11, 0.8, 3.5)),
      market:   poi('社区菜市场（模拟）', r1(12, 0.3, 2)),
      hospital: rnd(13) > 0.2 ? poi('综合医院（模拟）', r1(14, 1, 4)) : null,
      school:   poi('周边小学（模拟）', r1(15, 0.4, 3)),
      park:     rnd(16) > 0.2 ? poi('社区公园（模拟）', r1(17, 0.3, 4)) : null,
    },
  };
}

/* ---------- 地图渲染（消费 MapProvider / RouteProvider） ---------- */
const MAP_W = 1000, MAP_H = 640;

function mapViewBox() {
  const { cx, cy, scale } = state.mapView;
  const w = MAP_W / scale, h = MAP_H / scale;
  return `${clamp(cx - w / 2, -100, MAP_W)} ${clamp(cy - h / 2, -80, MAP_H)} ${w} ${h}`;
}
function mapFitAll() {
  if (state.usingReal && amapMap) {
    amapMap.setFitView(null, false, [80, 80, 80, 80]);
    return;
  }
  const pts = [...state.listings.map((l) => l.coord), MockMapProvider.companyCoord];
  fitViewTo(pts, 0.72);
}
function mapFocusSelected() {
  const l = state.listings.find((x) => x.id === state.selectedId);
  if (state.usingReal && amapMap) {
    const sel = amapOverlays.pins.find((p) => p.id === state.selectedId);
    const targets = [sel && sel.pin, amapOverlays.company].filter(Boolean);
    if (targets.length === 2) amapMap.setFitView(targets, false, [140, 140, 140, 140]);
    else amapMap.setFitView(null, false, [80, 80, 80, 80]);
    return;
  }
  if (!l) return mapFitAll();
  fitViewTo([l.coord, MockMapProvider.companyCoord], 0.6);
}
function fitViewTo(pts, fill) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs) || 100;
  const h = Math.max(...ys) - Math.min(...ys) || 100;
  state.mapView = {
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    scale: clamp(Math.min(MAP_W / w, MAP_H / h) * fill, 0.9, 3.2),
  };
}
function pathFrom(points, smooth) {
  if (points.length === 4) { // 地铁：家→进站→换乘→公司
    const [a, b, c, d] = points;
    return `M${a.x} ${a.y} L${b.x} ${b.y} Q${c.x} ${c.y} ${c.x + (d.x - c.x) * 0.25} ${c.y + (d.y - c.y) * 0.25} L${d.x} ${d.y}`;
  }
  const [a, m, b] = points;
  return smooth ? `M${a.x} ${a.y} Q${m.x} ${m.y} ${b.x} ${b.y}` : `M${a.x} ${a.y} L${m.x} ${m.y} L${b.x} ${b.y}`;
}
function mapBaseTexture() {
  return `
    <rect x="-200" y="-160" width="1400" height="960" fill="#10201E"/>
    <g stroke="#1B332F" stroke-width="1.4" fill="none">
      ${[80, 200, 320, 440, 560].map((y) => `<path d="M-100 ${y} H1100"/>`).join('')}
      ${[100, 260, 420, 580, 740, 900].map((x) => `<path d="M${x} -100 V740"/>`).join('')}
    </g>
    <path d="M545 -60 Q600 140 545 300 Q500 460 575 700" fill="none" stroke="#1C3A38" stroke-width="34" stroke-linecap="round" opacity=".8"/>
    <path d="M545 -60 Q600 140 545 300 Q500 460 575 700" fill="none" stroke="#26474A" stroke-width="2" stroke-dasharray="2 8" opacity=".6"/>
    <text x="560" y="330" fill="#3D6266" font-size="15" transform="rotate(76 560 330)">黄 浦 江（示意）</text>`;
}
function renderMap() {
  const svg = $('#mapSvg');
  if (!svg || state.view !== 'step2') return;
  // 高德真实地图分支：隐藏模拟 SVG，渲染真实底图与覆盖物
  if (state.usingReal && amapMap) {
    svg.classList.add('hidden');
    $('#amapContainer').classList.remove('hidden');
    renderRealMap();
    return;
  }
  svg.classList.remove('hidden');
  $('#amapContainer').classList.add('hidden');
  const company = MockMapProvider.companyCoord;
  const selId = state.selectedId;

  // 路线：只画选中房源的路线（点击图钉切换）
  const routeL = state.listings.find((x) => x.id === selId);
  const routes = routeL ? (() => {
    const i = state.listings.indexOf(routeL);
    const r = RouteProvider.plan(routeL.coord, company, state.mapMode, routeL.commute[state.mapMode]);
    const color = LISTING_COLORS[i % LISTING_COLORS.length];
    const dash = (state.mapMode === 'bike' || state.mapMode === 'walk') ? 'stroke-dasharray="7 7"' : '';
    return `<path d="${pathFrom(r.points, true)}" fill="none" stroke="${color}"
      stroke-width="4.5" opacity="1" stroke-linecap="round" ${dash}/>`;
  })() : '';

  // 选中路线的站点
  const selL = state.listings.find((x) => x.id === selId);
  let stops = '';
  if (selL) {
    const r = RouteProvider.plan(selL.coord, company, state.mapMode, selL.commute[state.mapMode]);
    stops = r.stops.map((s) => `
      <g><circle cx="${s.p.x}" cy="${s.p.y}" r="7" fill="#F7F6F2" stroke="#18201E" stroke-width="2.5"/>
      <text x="${s.p.x + 11}" y="${s.p.y + 4}" fill="#F7F6F2" font-size="12">${s.label}</text></g>`).join('');
  }

  // 房源图钉
  const pins = state.listings.map((l, i) => {
    const sel = l.id === selId;
    const color = LISTING_COLORS[i % LISTING_COLORS.length];
    const r = sel ? 19 : 15;
    return `<g data-pin="${l.id}" style="cursor:pointer">
      ${sel ? `<circle cx="${l.coord.x}" cy="${l.coord.y}" r="30" fill="${color}" opacity=".25"/>` : ''}
      <circle cx="${l.coord.x}" cy="${l.coord.y}" r="${r}" fill="${color}" stroke="#F7F6F2" stroke-width="2.5"/>
      <text x="${l.coord.x}" y="${l.coord.y + 5}" text-anchor="middle" fill="#fff" font-size="${sel ? 16 : 13}" font-weight="800">${String.fromCharCode(65 + i)}</text>
    </g>`;
  }).join('');

  // 公司图钉
  const companyPin = `
    <g>
      <rect x="${company.x - 16}" y="${company.y - 16}" width="32" height="32" rx="9" fill="#18201E" stroke="#C9A66B" stroke-width="2.5"/>
      <text x="${company.x}" y="${company.y + 5}" text-anchor="middle" fill="#C9A66B" font-size="14" font-weight="800">司</text>
      <text x="${company.x}" y="${company.y + 34}" text-anchor="middle" fill="rgba(247,246,242,.75)" font-size="12">公司</text>
    </g>`;

  svg.setAttribute('viewBox', mapViewBox());
  svg.innerHTML = mapBaseTexture() + routes + stops + pins + companyPin;
  renderMapInfo();
  document.querySelectorAll('#mapModes .map-mode').forEach((b) => {
    b.classList.toggle('active', b.dataset.mm === state.mapMode);
  });
}

function renderMapInfo() {
  const l = state.listings.find((x) => x.id === state.selectedId);
  if (!l) { $('#mapInfo').innerHTML = ''; return; }
  const i = state.listings.indexOf(l);
  const opt = l.commute[state.mapMode];
  const cons = modeConservative(state.mapMode, opt);
  const depart = parseTime(state.arriveTime) - cons;
  const r = RouteProvider.plan(l.coord, MockMapProvider.companyCoord, state.mapMode, opt);
  $('#mapInfo').innerHTML = `
    <div class="mi-mode">房源 ${String.fromCharCode(65 + i)} · 推荐${TRANSPORT_LABEL[state.mapMode]}通勤</div>
    <div class="mi-time">${fmtTime(depart)}</div>
    <div class="mi-sub">建议最晚出发 · 保守通勤 ${cons} 分钟</div>
    <div class="mi-sub">常规 ${opt.duration} 分钟 · ${opt.distance} 公里 · 换乘 ${opt.transfers} 次 · ${r.dailyFee} 元/天</div>`;
}

/* 结果页 Hero 的小地图（静态预览） */
function miniMapSvg(c) {
  const company = MockMapProvider.companyCoord;
  const r = RouteProvider.plan(c.coord, company, c.rec.mode, c.commute[c.rec.mode]);
  const xs = [c.coord.x, company.x], ys = [c.coord.y, company.y];
  const w = Math.max(Math.abs(xs[0] - xs[1]), 160), h = Math.max(Math.abs(ys[0] - ys[1]), 160);
  const vb = `${Math.min(...xs) - w * 0.35} ${Math.min(...ys) - h * 0.4} ${w * 1.7} ${h * 1.8}`;
  const color = LISTING_COLORS[c.idx % LISTING_COLORS.length];
  return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid slice">
    <rect x="-2000" y="-2000" width="5000" height="5000" fill="#10201E"/>
    <path d="M545 -2000 Q600 140 545 300 Q500 460 575 2000" fill="none" stroke="#1C3A38" stroke-width="34" opacity=".8"/>
    <path d="${pathFrom(r.points, true)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="${c.coord.x}" cy="${c.coord.y}" r="17" fill="${color}" stroke="#F7F6F2" stroke-width="2.5"/>
    <text x="${c.coord.x}" y="${c.coord.y + 5}" text-anchor="middle" fill="#fff" font-size="14" font-weight="800">${String.fromCharCode(65 + c.idx)}</text>
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

    const commuteNotice = c.rec.unsuitable ? `
      <div class="commute-warning">
        该房源暂无适合作为日常上班的通勤方案。最快可行方式为${TRANSPORT_LABEL[c.rec.mode]}：保守通勤 ${c.rec.cons} 分钟，建议 ${fmtTime(c.departMin)} 出发。<br>
        建议：放宽通勤上限；调整公司地址或到达时间；或将该房源从优先候选中排除。
      </div>` : '';

    const commuteHtml = TRANSPORT_MODES.map((m) => {
      const opt = c.commute[m];
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
              <span>${inRange ? `${a.name} · ${a.dist}km · 步行约${a.walkMin}分钟 / 驾车约${a.driveMin}分钟` : `${r}km 范围内暂无（模拟数据）`}</span></div>
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
            <div class="module-title">周边配套（模拟数据）</div>
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
}

/* =========================================================
 * AI 决策助手（只解释已有结构化结果，不参与计算）
 * ========================================================= */
const AI_PRESETS = [
  '如果我不想早于 07:30 出门，哪些房源还能选？',
  '为什么这套房排第一？',
  '标准推荐和按我的偏好排名为什么不一样？',
  '我更看重学校和医院，应该调整哪些权重？',
  '看房前需要线下核验哪些事项？',
];
const AI_NOTE = '\n\n（以上仅基于页面已有的模拟数据与评分结果进行解释，不构成租房/购房建议；硬约束结果以页面判定为准。）';

function aiAnswer(q) {
  const cs = state.computed;
  const ranks = currentRanks();
  const order = currentOrder();
  const name = (c) => `房源 ${String.fromCharCode(65 + c.idx)}（${c.name}）`;
  const w = state.weights;

  if (/出门|起床|早起/.test(q)) {
    const m = q.match(/(\d{1,2})\s*[:：点]\s*(\d{2})/);
    const limit = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : parseTime('07:30');
    const ok = cs.filter((c) => c.departMin >= limit);
    const no = cs.filter((c) => c.departMin < limit);
    const t = fmtTime(limit);
    const head = ok.length
      ? `不早于 ${t} 出门还能选：${ok.map((c) => `${name(c)}（${TRANSPORT_LABEL[c.rec.mode]}保守 ${c.rec.cons} 分钟，最晚 ${fmtTime(c.departMin)} 出发）`).join('；')}。`
      : `按当前数据，所有房源都需要在 ${t} 前出发（基于保守通勤时间）。`;
    const tail = no.length ? `\n\n需要排除：${no.map((c) => `${name(c)} 需 ${fmtTime(c.departMin)} 出发`).join('；')}。` : '';
    return head + tail + AI_NOTE;
  }
  if (/差异|不一样|不同|排名变化|为什么.*排名|排名.*为什么/.test(q)) {
    const diffs = cs.filter((c) => state.stdRanks[c.id] !== state.personalRanks[c.id]);
    if (!diffs.length) return `当前两种模式下排名完全一致，因为你的偏好权重与标准权重相同。在第 3 步选择偏好或调整权重后，这里会解释排名变化原因。${AI_NOTE}`;
    return `两种模式的排名差异来自权重不同（数据与硬约束完全一致）：\n${diffs.map((c) =>
      `· ${name(c)}：标准第 ${state.stdRanks[c.id]} 名 → 偏好第 ${state.personalRanks[c.id]} 名。${diffReason(c)}。`).join('\n')}${AI_NOTE}`;
  }
  if (/权重|调整|更看重|重视/.test(q)) {
    const tips = [];
    if (/学校|教育|学区/.test(q)) tips.push('把「教育资源」权重从 10% 提高到 20% 左右');
    if (/医院/.test(q)) tips.push('在「生活便利」细项中提高「医院」权重');
    if (/地铁|通勤|出门/.test(q)) tips.push('提高「通勤」权重，并在通勤细项中提高「地铁优先 / 最晚出发时间」');
    if (/便宜|预算|成本|租金/.test(q)) tips.push('提高「成本」权重，或把预算设为「必须满足」的硬约束');
    if (!tips.length) tips.push('可以告诉我你看重什么（如学校、医院、地铁、预算），我会建议对应权重');
    return `建议调整：${tips.map((t, i) => `${i + 1}. ${t}`).join('；')}。\n\n注意：我只能提出建议，不会自动修改权重——请在第 3 步「高级设置」中确认调整。${AI_NOTE}`;
  }
  if (/核验|线下|看房|注意|产权|噪音|采光/.test(q)) {
    return `看房前建议线下核验以下事项（这些不在模拟数据范围内）：\n1. 噪音：早晚高峰临路/临地铁噪音；\n2. 采光：不同时段实地采光与遮挡；\n3. 楼龄与电梯、物业维护状况；\n4. 房屋产权与租约合规性；\n5. 学区资格：本页面学校信息仅为周边教育资源，入学资格请以教育部门及房产政策为准；\n6. 通勤：在目标时段实测一次完整通勤。${AI_NOTE}`;
  }
  // 默认：解释当前最推荐
  const top = order.find((c) => c.status !== 'ineligible');
  if (!top) return `当前没有满足全部底线的房源，因此无法给出最推荐。建议返回第 1 步放宽底线。${AI_NOTE}`;
  const ex = ruleExplain(top);
  return `${name(top)}在${state.mode === 'standard' ? '标准推荐' : '按我的偏好'}模式下排名第 ${ranks[top.id]}（综合适配分 ${scoreOf(top, w)}）：\n${ex.bullets.map((b) => '· ' + b).join('\n')}\n\n权重构成：${DIMS.map((d) => `${d.label} ${w[d.key]}%`).join(' / ')}。${AI_NOTE}`;
}

function aiPush(text, who) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;
  div.textContent = text;
  if (who === 'bot') {
    const src = document.createElement('span');
    src.className = 'msg-src';
    src.textContent = '仅解释已有计算结果 · Demo 模拟数据';
    div.appendChild(src);
  }
  $('#aiMessages').appendChild(div);
  $('#aiMessages').scrollTop = $('#aiMessages').scrollHeight;
}
function aiOpen() {
  $('#aiPanel').classList.add('open');
  if (!$('#aiMessages').children.length) {
    aiPush('你好，我是你的选房决策助手。我只基于页面已有的房源数据与评分结果做解释，不参与打分，也不会编造地图或学区信息。可以点击下方快捷问题试试。', 'bot');
  }
}
function aiAsk(q) {
  if (!q.trim()) return;
  if (!state.computed.length) computeAll();
  aiPush(q, 'user');
  setTimeout(() => aiPush(aiAnswer(q), 'bot'), 350);
}

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
  });
  $('#arriveTime').addEventListener('input', (e) => {
    state.arriveTime = e.target.value || '09:00';
    // 到达时间变化 → 未来路线规划缓存失效，下次进入第 2 步时按新时刻重查
    state.listings.forEach((l) => { l._futureSig = null; });
  });
  $('#prefTransportCaps').addEventListener('click', (e) => {
    const btn = e.target.closest('.capsule');
    if (!btn) return;
    state.prefTransport = btn.dataset.pt;
    document.querySelectorAll('#prefTransportCaps .capsule').forEach((b) => b.classList.toggle('active', b === btn));
  });

  // 第 1 步：底线条件
  $('#constraintGrid').addEventListener('click', (e) => {
    const segBtn = e.target.closest('.seg button');
    if (segBtn) {
      const key = segBtn.parentElement.dataset.ckey;
      state.constraints[key].lv = Number(segBtn.dataset.lv);
      renderConstraints();
      return;
    }
    const capBtn = e.target.closest('[data-ccaps] button');
    if (capBtn) {
      const key = capBtn.closest('[data-ccaps]').dataset.ccaps;
      const v = Number(capBtn.dataset.v);
      if (key === 'budget') state.budget = v;
      else state.constraints[key].val = v;
      renderConstraints();
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
  });

  // 第 2 步：房源卡片
  $('#listingList').addEventListener('input', (e) => {
    const id = Number(e.target.dataset.id), f = e.target.dataset.f;
    if (!id || !f) return;
    const l = state.listings.find((x) => x.id === id);
    l[f] = (f === 'rent' || f === 'area') ? Number(e.target.value) : e.target.value;
  });
  $('#listingList').addEventListener('change', (e) => {
    // 地址变化 → 真实模式下重新地理编码并刷新通勤/配套；模拟模式仅重新生成虚拟坐标
    const id = Number(e.target.dataset.id), f = e.target.dataset.f;
    if (id && f === 'address') {
      const l = state.listings.find((x) => x.id === id);
      if (l) {
        l._realSig = null;
        if (!seedListings().some((s) => s.id === id)) l.coord = MockMapProvider.geocode(l.address, id);
        if (USE_AMAP) {
          setMapLoading(true);
          ensureRealData().then(() => {
            setMapLoading(false);
            computeAll(); renderListingCards(); mapFocusSelected(); renderMap(); updateDataBadge();
          });
          return;
        }
      }
    }
    computeAll(); renderListingCards(); renderMap();
  });
  $('#listingList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (state.listings.length <= 2) return;
      const id = Number(del.dataset.del);
      state.listings = state.listings.filter((l) => l.id !== id);
      if (state.selectedId === id) state.selectedId = state.listings[0].id;
      computeAll(); renderListingCards(); mapFitAll(); renderMap();
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel && !e.target.closest('input, select, textarea')) {
      state.selectedId = Number(sel.dataset.select);
      renderListingCards();
      mapFocusSelected();
      renderMap();
    }
  });
  $('#addListingBtn').addEventListener('click', () => {
    if (state.listings.length >= 5) return;
    const id = state.nextId++;
    state.listings.push({
      id, name: `新房源 ${String.fromCharCode(64 + state.listings.length + 1)}`,
      address: '上海市（请填写地址）', rent: 6500, area: 55,
      layout: '1室1厅', floor: '5/12层', facing: '南', note: '',
      coord: MockMapProvider.geocode('新房源', id),
      ...generateMockData(id),
    });
    state.selectedId = id;
    computeAll(); renderListingCards(); mapFocusSelected(); renderMap();
    if (USE_AMAP) {
      setMapLoading(true);
      ensureRealData().then(() => {
        setMapLoading(false);
        computeAll(); renderListingCards(); mapFocusSelected(); renderMap(); updateDataBadge();
      });
    }
  });

  // 第 2 步：地图控件
  $('#mapModes').addEventListener('click', (e) => {
    const btn = e.target.closest('.map-mode');
    if (!btn) return;
    state.mapMode = btn.dataset.mm;
    renderMap();
  });
  $('#mapZoomIn').addEventListener('click', () => {
    if (state.usingReal && amapMap) { amapMap.zoomIn(); return; }
    state.mapView.scale = clamp(state.mapView.scale * 1.3, 0.9, 4); renderMap();
  });
  $('#mapZoomOut').addEventListener('click', () => {
    if (state.usingReal && amapMap) { amapMap.zoomOut(); return; }
    state.mapView.scale = clamp(state.mapView.scale / 1.3, 0.9, 4); renderMap();
  });
  $('#mapFit').addEventListener('click', () => { mapFitAll(); renderMap(); });

  // 地图拖动 + 图钉点击
  (function bindMapDrag() {
    const svg = $('#mapSvg');
    let dragging = false, moved = 0, sx = 0, sy = 0, scx = 0, scy = 0;
    svg.addEventListener('pointerdown', (e) => {
      dragging = true; moved = 0; sx = e.clientX; sy = e.clientY;
      scx = state.mapView.cx; scy = state.mapView.cy;
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const k = (MAP_W / state.mapView.scale) / rect.width;
      const dx = (e.clientX - sx) * k, dy = (e.clientY - sy) * k;
      moved = Math.max(moved, Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy));
      state.mapView.cx = scx - dx;
      state.mapView.cy = scy - dy;
      svg.setAttribute('viewBox', mapViewBox());
    });
    svg.addEventListener('pointerup', (e) => {
      dragging = false;
      if (moved < 6) {
        const pin = e.target.closest('[data-pin]');
        if (pin) {
          state.selectedId = Number(pin.dataset.pin);
          renderListingCards();
          mapFocusSelected();
          renderMap();
        }
      }
    });
  })();

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
  });

  // 第 3 步：模式卡片
  $('#modeCards').addEventListener('click', (e) => {
    const card = e.target.closest('.mode-card');
    if (!card) return;
    state.mode = card.dataset.mode;
    renderModeCards();
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

  // AI 面板
  $('#aiFab').addEventListener('click', aiOpen);
  $('#aiOpenBtn').addEventListener('click', aiOpen);
  $('#aiClose').addEventListener('click', () => $('#aiPanel').classList.remove('open'));
  $('#aiSend').addEventListener('click', () => { aiAsk($('#aiInput').value); $('#aiInput').value = ''; });
  $('#aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { aiAsk($('#aiInput').value); $('#aiInput').value = ''; } });
  const quick = $('#aiQuick');
  AI_PRESETS.forEach((q) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', () => aiAsk(q));
    quick.appendChild(b);
  });
}

/* ---------- 初始化 ---------- */
renderConstraints();
bindEvents();
