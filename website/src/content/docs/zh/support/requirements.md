---
draft: false
title: 系统要求与已知限制
description: ReadAny 支持的平台、运行时要求与当前限制。
---

本页描述当前 1.3.x 版本。标注为“已知限制”的问题仍在跟踪中，不代表已有确定的修复版本或发布时间。

## 桌面端

| 平台 | 安装包 | 运行时 |
|---|---|---|
| macOS（Apple Silicon） | `.dmg` | 系统 WebKit；请让 macOS 保持在仍接收安全更新的版本 |
| macOS（Intel） | `.dmg` | 系统 WebKit；请让 macOS 保持在仍接收安全更新的版本 |
| Windows（x64） | `.msi` / `.exe` | Microsoft Edge WebView2 Runtime |
| Linux（x64） | `.AppImage` / `.deb` | WebKitGTK 4.1（`libwebkit2gtk-4.1`）与 GTK 3 |

Windows 10 和 Windows 11 的当前安装通常已包含 WebView2。如果 ReadAny 打开后是空白窗口，或 PDF 无法显示，请更新 [Microsoft Edge WebView2 Runtime](https://learn.microsoft.com/microsoft-edge/webview2/) 后重试。

Linux 的 AppImage 只打包应用本身，仍依赖系统的 WebKitGTK 4.1。如果 AppImage 无法启动，请安装发行版提供的 WebKitGTK 4.1 软件包。

## 移动端

| 平台 | 分发方式 | 要求 |
|---|---|---|
| Android | 从发布页下载 `.apk` | 侧载 APK；允许浏览器或文件管理器安装未知来源应用 |
| iOS / iPadOS | TestFlight | 通过 README 下载表中的链接加入当前 TestFlight 构建 |

Android 通过 APK 分发，不经过应用商店。安装步骤：

1. 从发布页下载 APK。
2. 在提示时允许浏览器或文件管理器安装未知来源应用。
3. 打开 APK 并确认安装。
4. 如果 Android 提示签名不一致，请先卸载旧的 ReadAny。卸载可能清除本机应用数据，操作前请先同步或导出需要保留的内容。

**不支持 Expo Go。** ReadAny 使用原生模块和自定义开发客户端。开发时请使用 Expo development build（`pnpm expo:ios`、`pnpm expo:ios:simulator` 或 `pnpm expo:android`）；Expo Go 无法加载本应用。

## 存储与内存

- 书籍文件是磁盘占用的主要部分。请为书库、封面、本地数据库和语义搜索使用的向量索引预留空间。
- 语义搜索与本地 embedding 在本机运行。书库越大，索引耗时越长；向量化过程会占用 CPU 和内存。
- 首次配置本地 embedding 时可能需要下载模型，请预留磁盘空间和网络。
- 建议至少保留数百 MB 空闲空间，用于数据库和传输临时文件。

## 同步要求

ReadAny 不包含云服务，也不提供 WebDAV 服务端。同步需要以下之一：

- 可通过 HTTPS 访问的 WebDAV 账号或自建服务
- S3 兼容存储桶

设置方法、远端目录结构和最小 wsgidav 部署见 [WebDAV 同步](/ReadAny/zh/support/sync/webdav/)；S3 兼容存储见 [S3 同步](/ReadAny/zh/support/sync/s3/)。如果服务商支持，请使用应用专用密码。

网络建议：

- 首次同步和上传大文件时，尽量使用稳定网络。
- 书籍文件传输超时为 300 秒；元数据请求使用更短的超时。
- 使用较弱的 NAS 或消费级 WebDAV 网关时，把**同步并发数**降到 1–2。
- WebDAV 服务端必须接受 `PROPFIND`、`MKCOL`、`HEAD`、`PUT`、`GET`、`MOVE`、`DELETE`。`HEAD` 用于存在性检查，服务器不支持时会回退到 `PROPFIND`。

## 已知限制

### 同步与书籍文件

- 元数据同步与书籍文件同步是两个阶段。元数据同步成功时，书籍文件仍可能失败；同步详情会报告失败数量。
- 在 WebDAV 和 S3 上，普通同步不会批量下载远端书籍文件。打开远端书籍时才会下载，或使用**全量下载**一次拉取全部内容。封面缺失时会自动补齐，即使普通同步不下载书籍文件。
- 局域网传输不同：**导入另一台设备数据**会接收对方快照，并通过局域网下载缺失的书籍和封面。
- **测试连接**在 WebDAV 上还会创建同步目录；在 S3 上只验证能否列出配置前缀，写入、删除和复制权限要到首次同步时才会实际使用（见 [S3 同步](/ReadAny/zh/support/sync/s3/)）。

### 大文件

用户反馈记录了部分环境在 200 MB 以上失败；这不是官方规格限制。桌面端上传路径会先把文件读入内存再发送，书籍文件传输超时为 300 秒。请尽量让单本书保持在 200 MB 以下；超大 PDF 或漫画压缩包建议拆分。

这是仍在排查中的已知限制，尚未修复。

### PDF 渲染

- PDF 是固定版式格式。ReadAny 提取文本层，因此复杂版式、表格和扫描页可能无法按原样显示。
- Windows 上较旧的 WebView2 运行时可能无法显示 PDF，请更新 WebView2。
- 超大或损坏的 PDF 可能打开缓慢或解析失败。

### 安全与隐私

- 同步数据以明文文件保存在你的 WebDAV 或 S3 服务商处。ReadAny 不提供端到端加密，服务商可以读取书籍文件和同步 JSON。
- **允许不安全连接**会削弱传输安全。桌面端会关闭 TLS 证书校验，移动端可能把 `https://` 改写为 `http://`。仅应在受信任局域网内、配合自签名证书或明文 HTTP 时使用。

### 内容

- ReadAny 仅支持无 DRM 的书籍。
- TXT 和 UMD 文件会在导入时转换为 EPUB。
- 其他格式之间的转换不在当前版本范围内。

### 平台

- 桌面端自动更新需要访问发布下载地址。网络屏蔽 GitHub Releases 时，需要手动下载安装包。
- 移动端开发需要 Expo development build，不支持 Expo Go。
- iOS 通过 TestFlight 分发，可能受测试名额或构建可用性限制。

## 相关页面

- [安装指南](/ReadAny/zh/support/installation/)
- [WebDAV 同步](/ReadAny/zh/support/sync/webdav/)
- [S3 同步](/ReadAny/zh/support/sync/s3/)
- [常见问题](/ReadAny/zh/support/faq/)
