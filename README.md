# Agent Product 01 — Minimal Demo

这个最小 demo 提供一个可运行的 Express + Socket.IO 服务以及一个静态前端页面，演示：

- 前端通过 Socket.IO 发送 user_message
- 服务端以分片（chunk）形式推送 agent 响应，模拟 LLM 流式输出

如何运行：

1. 在仓库根目录运行：

   npm install

2. 启动服务：

   npm start

3. 打开浏览器访问：http://localhost:4000/ 查看聊天界面

备注：此 demo 只是最小可运行样例，用于演示流式对话和看板开发流程的起点。后续可以：
- 替换为真实 LLM 调用（OpenAI/Anthropic）并将流式输出转发给客户端
- 将会话/消息保存到数据库（Postgres）
- 添加场景管理页面和 Dashboard
