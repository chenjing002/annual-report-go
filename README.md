# 年报速查

输入 A 股股票代码或简称，直达近 10 个财务年度的年报 PDF（巨潮资讯网）。

线上地址：https://ashare-report-finder.chenjingluote.workers.dev/

## 结构

- `public/` — 前端页面与股票列表 `stocks.json`，作为 Workers 静态资源发布
- `src/worker.mjs` — `/api/reports?code=000002` 接口，查询巨潮资讯并缓存结果
- `src/core.mjs` — 年报标题解析、版本筛选与分组

## 开发与部署

```sh
npm install
npm run dev     # 本地预览
npm run deploy  # 发布到 Cloudflare Workers
```
