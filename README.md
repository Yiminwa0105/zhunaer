# 住哪儿 · 别再凭感觉选房

一个**可解释的智能房源对比决策工具**：输入公司地址和通勤底线，添加 2–5 套候选房源，系统基于真实地图数据计算通勤、成本、生活便利、教育资源、居住条件五个维度的得分，给出有依据、有底线、可追问的选房报告。

> 在线 Demo：<https://zhunaer.pages.dev>（Cloudflare Pages）
> 备用地址：<https://yiminwa0105.github.io/zhunaer/>（GitHub Pages）

## 核心设计理念

- **可解释**：每个分数都能拆开看——维度得分 × 权重 = 综合适配分，评分说明逐条列出
- **有底线**：「必须满足」是硬约束，硬伤不被优点掩盖；不满足核心条件的房源直接降级
- **重可靠**：用「保守通勤」（常规时长 + 波动缓冲 + 到楼缓冲）倒推最晚出发时间，而不是用乐观时间
- **两阶段通勤推荐**：先判断某种交通方式是否适合日常上班（骑行 ≤8km/35min、步行 ≤2km/25min 等门槛），再只在适合的方式中选推荐——交通费用永远只是最后的比较项，不会出现"骑行 68 分钟 3 元"击败"驾车 55 分钟 44 元"的情况

## 功能一览

| 模块 | 说明 |
|---|---|
| 通勤与底线 | 公司地址、到达时间、出行偏好、11 项可分级底线（无所谓/希望有/很重要/必须满足） |
| 房源与地图 | 2–5 套房源，高德真实地图，点击图钉切换选中房源的通勤路线，支持地铁/驾车/骑行/步行四种方式 |
| 我的偏好 | 最多选 3 项关注点自动生成建议权重，支持高级设置微调每个维度/细项权重 |
| 选房报告 | 决策结论 Hero、多目标标签、横向对比卡片、完整数据表、标准 vs 偏好排名差异解释、单房源评分依据 |
| AI 决策助手 | 只解释已有计算结果，不参与评分、不编造数据 |

## 数据来源

| 数据 | 来源 | 说明 |
|---|---|---|
| 地图显示 | 高德 JS API 2.0 | 深蓝暗色底图 |
| 地址 → 坐标 | 高德地理编码（AMap.Geocoder） | 公司与房源地址 |
| 通勤时长/距离/换乘 | 高德路线规划（Transfer/Driving/Walking/Riding） | 实时规划，典型时长 |
| 周边配套 | 高德 POI 搜索（AMap.PlaceSearch） | 地铁站/盒马/奥乐齐/山姆/大润发/菜场/医院/学校/公园，5km 内最近一个 |
| 分时段驾车时长（可选） | 高德 ETD 未来路线规划 | 经 Cloudflare Worker 代理；**该接口仅企业开发者开放**，无权限时自动回退缓冲模型 |
| 兜底数据 | 内置模拟数据 | 任何接口失败时保留页面可用，顶部徽标会标识当前数据状态 |

## 技术栈

- 纯静态前端：原生 HTML / CSS / JavaScript，零框架、零构建
- 高德地图 JS API 2.0（前端 Key，域名白名单防盗刷）
- Cloudflare Worker：代理高德 Web服务 ETD 接口（解决跨域 + 隐藏 Web服务 Key）
- 部署：GitHub Pages / Cloudflare Pages

## 文件结构

```text
zhunaer/
├── index.html        # 页面结构（含高德 JS API Key 与安全密钥配置）
├── styles.css        # 全部样式
├── app.js            # 全部逻辑：评分引擎 + 高德 Provider + 交互
├── worker.js         # Cloudflare Worker：ETD 未来路线规划代理
├── wrangler.toml     # Worker 配置
├── package.json      # wrangler 开发依赖
├── v2/               # 界面改版实验目录（未接入主流程）
└── README.md
```

`app.js` 内部分层：顶部为配置与数据层（含 `MockMapProvider` 模拟实现 + 高德真实 Provider，评分引擎只消费统一结构），中部为评分引擎（硬约束 + 加权评分），底部为视图渲染与事件绑定。

## 本地开发

```bash
# 1. 启动静态服务（任选其一）
python -m http.server 8080
npx serve .

# 2. （可选）启动 ETD 代理，启用分时段驾车时长
npm install
npm run dev        # wrangler dev，监听 127.0.0.1:8787

# 浏览器打开 http://localhost:8080/
```

ETD 代理的 Key 配置：本地放在 `.dev.vars`（已 gitignore），线上用 `wrangler secret put AMAP_WEB_KEY`。

## 部署

**GitHub Pages**：仓库 Settings → Pages → Source 选 `main` 分支根目录。

**Cloudflare Pages（静态站点）**：

```bash
wrangler pages deploy dist --project-name zhunaer   # dist 内含 index.html / app.js / styles.css
```

**Cloudflare Worker（ETD 代理）**：

```bash
wrangler secret put AMAP_WEB_KEY   # 高德 Web服务 Key
wrangler deploy                    # worker.js
```

> 注意：`*.workers.dev` 默认域名在中国大陆网络不可达，正式使用需在 Cloudflare 绑定自定义域名。

## 上线前安全检查

- [ ] 高德控制台为 JS API Key 配置域名白名单（`用户名.github.io`、`项目.pages.dev`、自定义域名）
- [ ] 确认 `.dev.vars` 未被提交（含 Web服务 Key）
- [ ] 在高德控制台「流量分析」关注配额用量

## 免责声明

- 学校信息仅展示周边教育资源，**不代表学区资格**，请以教育部门及房产政策为准
- 通勤时间为路线规划结果 + 缓冲模型估算（P90 口径），不构成通勤承诺
- 所有评分仅用于辅助决策，不构成任何房产、教育或入学建议；看房前请线下核验噪音、采光、产权、租约等事项

## License

[MIT](LICENSE)
