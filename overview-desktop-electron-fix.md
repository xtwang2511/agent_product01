# 桌面端 `npm start` 报错修复概览

## 现象
```
> electron .
Downloading Electron binary...
Downloading electron-v43.4.0-win32-x64.zip: [100%]
Error: Generated checksum for "electron-v43.4.0-win32-x64.zip" did not match expected checksum.
```
同时用户反馈下载"很慢"。

## 根因
- 桌面端 `zhhs01-desktop/package.json` 锁 `electron@^43.4.0`；本地 Electron 缓存只有早先下好的 v31.7.7，无 v43 缓存。
- 工程未配镜像源，`@electron/get` 默认走 GitHub Releases 下载 v43.4.0；该源在当前网络环境被截坏，下到的是损坏/不一致的包，导致校验和不符、下载缓慢。

## 修复
1. **固化镜像源（持久根治）**：在 `zhhs01-desktop/.npmrc` 写入
   ```
   electron_mirror=https://npmmirror.com/mirrors/electron/
   ```
   `@electron/get` 与 `electron-builder`（打包 dist 时也需 Electron）均读取此配置，今后 `npm start` 与 `npm run dist` 都不会再卡。
2. **预下载正确二进制**：
   - 从镜像下载 v43.4.0 zip（144MB，17 秒），SHA256 = `ef0709cfa719739acce73de6f9b684304baf38c6454376638a70d34a7cecffe0`，与 CDN 公布的 v43.4.0 校验和**逐字节一致**。
   - 清掉陈旧的 `node_modules/electron/dist`，让 `install.js` 从正确的 v43 缓存 zip 重新解压。

## 验证（关键排除误判）
- 沙箱无显示器下 `electron.exe --version` 会回退打印**内置 Node 版本**（v43→24.18.1、v31→20.18.0），属假象，不是真版本错乱。
- 在二进制字节中搜版本字符串确认：`node_modules/electron/dist/electron.exe` 含 `43.4.0` = **True** → 确为 Electron 43.4.0，原始 checksum 报错已根除。
- 临时解压目录已清理；缓存仅保留 v43.4.0 / v31.7.7 两个 zip。

## 用户操作
直接重新 `npm start` 即可——此时 Electron 二进制已就位，无需再下载、不再报 checksum 错误、秒开。
