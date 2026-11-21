# 抖音视频入表 · DouyinVideoSheet

当前版本：**v1.2.4**。

Chrome / Edge 浏览器扩展：在抖音视频和图文详情页显示可收起的悬浮面板，将视频信息与高赞评论复制到 WPS，并保留原有 Excel 入表工作台。

## 下载与安装

1. 下载 [DouyinVideoSheet-v1.2.4.zip](releases/DouyinVideoSheet-v1.2.4.zip?raw=true)，解压到固定目录。
2. Chrome 打开 `chrome://extensions/`，Edge 打开 `edge://extensions/`，开启开发者模式，加载 `DouyinVideoSheet/extension`。
3. 刷新抖音详情页，点右下角“入表 · 展开”。更新旧版时替换原 extension 文件夹里的文件，再在扩展管理页点“重新加载”。

详细步骤见 [安装与 WPS 使用说明](DouyinVideoSheet/安装与WPS使用说明.txt)。ZIP 的 SHA-256 校验文件位于 releases 文件夹。

## 功能

- 支持 `/video/` 视频页、`/note/` 图文页和带作品 ID 的弹层。
- 视频只复制一行数据，不附带表头；面板列出字段与数值，文案字段名称为“标题”。
- 评论按已读取范围的点赞数排序，复制最多 20 条为一个单元格的文本；保留单元格富文本与纯文本两种剪贴板格式。
- v1.2.4 补充图文封面、作者及互动数的读取与重试。
- 原 Excel 工作台、批量采集、封面图片和内容领域下拉流程保留。复制功能无需本地服务；Excel 功能使用包内原有的 1.2.0 本地服务。

## 使用限制与验证

- WPS 视频 ID 列先设为文本；粘贴评论建议先双击目标单元格或按 F2 进入编辑状态。
- 前 20 条仅按实际读取到的一级评论排序，不保证是全局前 20；登录、验证和页面变化会影响数据读取。
- Chrome 扩展与模拟页面测试通过，包括图文数据补读、零值、无表头复制、单元格评论粘贴。真实抖音账户、真实 WPS 与 Edge 尚未完整验收。
- 不含 DTK、AI、Markdown 内容导出、新服务器或 WPS API 写入。

[完整源码](DouyinVideoSheet) · [测试记录](DouyinVideoSheet/测试与更新说明.txt) · [MIT License](DouyinVideoSheet/LICENSE)
