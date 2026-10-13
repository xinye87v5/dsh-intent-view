# 虚拟判定样例（盲标）

共 12 条。**这份不显示模型结论**，避免锚定。

怎么标：在最后那列写 `偏` 或 `不偏`（只认这两个词）——判据是「**agent 当时理解成的那件事，
是不是用户这一回合要它做的那件事**」。节点上下文只用来理解"用户这句话要的是哪一步"。

标完跑：`node tools/probes/judge-cases.mjs --score research/judge-cases.md`

| # | 考点 | 节点上下文 | 用户指令 | agent 自述理解 | agent 回复摘要 | 你判 |
|---|---|---|---|---|---|---|
| C1 | 真偏离：agent 理解了另一件事 | 09章角色甲-1赠画 | 把 09 章第 121 天那段的时间线核对一下，那天他到基地多久了？ | The user wants me to draft the content of the painting 角色甲-1 gives to 小 | 我拟了三个画面方案：海面、灯塔与未寄出的信；并说明各自寓意。 | 偏 |
| C2 | 换个做法（不该判偏） | 双写改造 | 这个脚本别写两次了，改成一次写入 | The user wants the double-write removed; I'll restructure it into a si | 把两次写入合并成一次，并跑了原有测试，结果全绿。 | 不偏 |
| C3 | 简报回合 + 理解对（不该判偏） | 11章时间线修订 | 同意，继续 | The user agrees with the chapter-11 timeline fix plan; continue with t | 按方案改完 11 章三处时间戳。 | 不偏 |
| C4 | 简报回合 + 理解错（该判偏） | 11章时间线修订 | 同意，继续 | The user agrees to start the new registration-flow documentation task. | 开始写注册流程文档的初稿。 | 偏 |
| C5 | 指令不具体但理解对（不该判偏） | 20章一致性核查 | 继续吧 | Continue checking chapter 20 for internal consistency. | 继续核完 20 章，列出两处不一致。 | 不偏 |
| C6 | 必须借节点上下文才判得了（答案不偏） | 配给模型与基地设备对接（改由角色乙实施） | 改成那样吧 | The user wants the 01-02 setup changed so that 角色乙 does the device inte | 把对接执行方改为角色乙，并同步了 01-02 两处描述。 | 不偏 |
| C7 | 压缩后方向已换，agent 还在旧事（该判偏） | 发布流程自动化 | 继续 | Continue the license-selection discussion. | 继续比较 MIT 与 Apache 的差别。 | 偏 |
| C8 | 同义改写、字面不重合（不该判偏） | 术语统一 | 这几处措辞统一一下，别一会儿'概率期望'一会儿'期望概率' | The user wants the terminology normalized to one form. | 全篇统一为「概率期望」，共改 7 处。 | 不偏 |
| C9 | 理解对、回复里另夹带一件小事（按你的主张：不该判偏） | 09章赠画内容 | 把小满那幅画的内容定下来 | The user wants the painting's content decided. | 定了画的内容（灯塔与信）；顺手改了 12 章一处标点。 | 偏，多余任务 |
| C10 | 答非所问（该判偏） | 20章视角确认 | 20 章是谁的视角？ | The user is asking why this chapter exists at all. | 讨论了这一章存在的功能与写法安排。 | 偏，agent理解错误 |
| C11 | 用户要求回退，agent 去做记录（该判偏） | 角色乙设定渐进披露 | 你又一次性披露太多了，角色乙设定要按主角解析渐渐披露 | I need to update the revision log and check repository consistency. | 更新了修订日志并做了一次仓库一致性检查。 | 偏 |
| C12 | 多做收尾动作（不该判偏） | README 脚本清单 | 把 README 里的脚本清单补上 | Add the missing verify-task-* scripts to the README script list. | 补上三行脚本清单，顺手统一了表格空行。 | 不偏 |
