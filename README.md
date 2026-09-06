# PTCGL Replay+

宝可梦卡牌 Pokemon TCG Live 对战日志回放器 — 纯静态网页，打开即用。

## 功能

- 📂 导入 / 粘贴 PTCGL 结算界面的 battle log，逐步回放整局对战
- 🩺 实时显示每只宝可梦的**剩余血量**、伤害指示物、特殊状态（中毒/灼伤/混乱等）
- ⚡ 能量卡、道具卡附着一目了然
- 🃏 **主视角手牌全程明牌**（日志中可见的抽牌），对手手牌按公开信息部分揭示
- 🎯 指纹匹配精确到**具体印刷版本**：用日志中的招式/特性/进化链从 23,650 张卡的离线全库（TCGdex）中反推确切卡图
- 🏟️ 场地卡、放逐区（Lost Zone）、弃牌堆、奖品卡、Mulligan 全支持
- 📊 对局统计（抽牌/伤害/击倒/奖品）+ 卡牌出现记录
- ⏯️ 播放/暂停/变速/进度条/回合跳转，全键盘快捷键

## 使用

打开网站 → 导入 `.txt` 日志文件或粘贴日志文本 → 用播放控制条回放。

## 本地开发

```bash
npm run dev   # 静态服务器, 默认 7100 端口
```

## 数据

卡牌数据来自 [TCGdex](https://tcgdex.dev)（`public/data/cards-full.json`，23650 张英文卡牌的紧凑索引，由 `scripts/build-full-index.js` 从 tcgdex/cards-database 仓库编译）。卡图：本地缓存优先，未缓存走 TCGdex CDN。

## 许可

仅供学习交流。宝可梦卡牌相关素材版权归 The Pokémon Company / Nintendo / Creatures / GAME FREAK 所有。
