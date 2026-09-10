# Session-Manager-GUI

DeepSeek Harness（web profile）双半面插件（独立插件，当前版本 **0.1.5**）。

- **主机半面**（`lib/index.js`）：“会话回收站”数据层 + 已归档会话数据 +
  同源 JSON API（前缀 `/Session-Manager-GUI`，供浏览器半面调用）。
- **浏览器半面**（`lib/client.js`）：手写 `__ModuleLoader__` 产物，零构建；
  向设置页注册两个区块（“会话回收站” order 30、“已归档会话” order 31），
  并监听会话行菜单补丁派发的 `Session-Manager-GUI:delete` 事件。

## 界面变化

- 会话行右侧三点菜单新增第 4 项 **删除会话**，带与“会话回收站”一致的
  垃圾桶图标（`IconTrashOutline16`）；
- 设置导航新增 **会话回收站**（垃圾桶图标）与 **已归档会话**
  （归档图标），不再使用默认齿轮图标。

## 与 session-editor 的关系

两者是**不同的插件**：聊天工具（`session_editor_list` / `session_editor_restore`
/ `session_editor_delete`）由 `session-editor` 提供；本插件**不注册这些工具**，
因此可同时安装、互不冲突。WebUI 的“删除会话”是软删除（进回收站），
聊天工具的删除仍是永久删除。

## 安装 / 卸载 / 使用

见上一级目录《使用手册.md》；设计与风险记录见《开发日志.md》。

兼容性：DeepSeek Harness `0.1.5-rc.1` web profile（0.1.2 适配版）。

## 许可

本软件以 **公有领域（Public Domain）** 方式发布，采用 [The Unlicense](https://unlicense.org)：
任何个人或组织均可免费、无偿地复制、修改、发布、使用、编译、销售与分发，
包括**商用**，无需署名、无需保留声明、无任何附加条件。详见仓库根目录 `LICENSE`
（含附加免责声明：作者与贡献者不对本软件引起的次生效应、连锁反应或间接后果负责）。
