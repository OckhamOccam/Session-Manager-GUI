# Session-Manager-GUI

DeepSeek Harness（web profile）双半面插件（独立插件，当前版本 **0.1.1**）。

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

## 插件独立性

这是一个独立的插件，专注于 WebUI 会话管理功能。插件的“删除会话”是软删除（进回收站），
提供更安全的会话删除机制，避免误删导致的数据丢失。

## 安装 / 卸载 / 使用

见上一级目录《使用手册.md》；设计与风险记录见《开发日志.md》。

兼容性：DeepSeek Harness `0.1.2-rc.1` web profile。
