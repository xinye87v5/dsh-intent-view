# 虚拟判定样例（盲标）

共 12 条（第 4 批）。**这份不显示模型结论**，避免锚定。

怎么标：在最后那列写 `偏` 或 `不偏`（只认这两个词）——判据是「**agent 当时理解成的那件事，
是不是用户这一回合要它做的那件事**」。节点上下文只用来理解"用户这句话要的是哪一步"。

标完跑：`node tools/probes/judge-cases.mjs --score research/judge-cases.md`

**第三问那一列**（归属贴近度，独立于前两问）：这一回合做的事，与**父枝的目标**靠近吗？
写 `近` / `远` / `不适用`。参照物是**父枝本身**，不是"整个项目在做的事"——
同一个大项目下的另一条枝也算"远"。父枝写"（顶层枝）"时参照物是**这一枝自己的主题**，
只看领域有没有偏出去（不拿会话大目标卡具体操作）。过渡/收尾/说不清写 `不适用`。

| # | 考点 | 节点上下文 | 父枝（第三问的参照物） | 用户指令 | agent 自述理解 | agent 回复摘要 | 你判（偏/不偏） | 第三问（近/远/不适用） |
|---|---|---|---|---|---|---|---|---|
| P1 | （略——避免锚定） | 核对12306数据 | 示例站车次查询 | 顺便把 G1234 也加进去 | The user wants me to add train G1234 to the same check list. | 把 G1234 加进核对表，并标出经停站。 | 不偏 | 近 |
| P2 | （略——避免锚定） | 核对12306数据 | 示例站车次查询 | 把旅游方案的封面换成蓝色 | The user wants a blue cover for the travel proposal. | 改了旅游方案封面配色。 | 不偏 | 远 |
| P3 | （略——避免锚定） | 核对12306数据 | 示例站车次查询 | 先这样吧，谢谢 | The user is wrapping up. | 好的，随时叫我。 | 不偏 | 不适用 |
| P4 | （略——避免锚定） | 示例站车次查询 | （顶层枝：只判领域） | 查一下示例站当天所有车次 | The user wants all trains stopping at Zengcheng station. | 列出了当天经停示例站的车次。 | 不偏 | 近 |
| P5 | （略——避免锚定） | 修 DSH 插件 | （顶层枝：只判领域） | 帮我想想晚饭做什么菜 | The user wants dinner recipe ideas. | 给了三道菜的做法。 | 不偏 | 远 |
| P6 | （略——避免锚定） | 预算表 | 旅行方案 | 把住宿那栏的数字改一下 | The user wants the lodging row updated. | 按新价格改了住宿那栏。 | 不偏 | 近 |
| P7 | （略——避免锚定） | 核对12306数据 | 示例站车次查询 | 对了，帮我把 README 里那个错别字改了 | The user wants a typo fixed in README. | 改了 README 的错别字。 | 不偏 | 远 |
| P8 | （略——避免锚定） | 示例站车次查询 | （顶层枝：只判领域） | 继续 | The user wants me to continue. | 继续补完了剩下几趟车。 | 不偏 | 近 |
| P9 | （略——避免锚定） | 名字与性格 | 角色设定 | 把插画那一页的配色也定了吧 | The user wants the illustration page palette decided. | 定了插画页的配色。 | 不偏 | 远 |
| P10 | （略——避免锚定） | 统计每日经停车次 | 示例站数据分析 | 用 Python 跑一下这个统计 | The user wants the stats computed with Python. | 写了脚本并跑出统计。 | 不偏 | 近 |
| P11 | （略——避免锚定） | 09章时间线 | （顶层枝：只判领域） | 帮我查下明天北京天气 | The user wants tomorrow's Beijing weather. | 查了天气。 | 不偏 | 远 |
| P12 | （略——避免锚定） | 名字与性格 | 角色设定 | 先停一下，我看看 | The user wants to pause and review. | 好，随时继续。 | 不偏 | 不适用 |
