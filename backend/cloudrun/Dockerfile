FROM node:20-alpine

WORKDIR /app

# 仅复制依赖清单；本服务 dependencies 为空，安装步几乎无操作，保留以兼容后续扩展
COPY package.json ./
RUN npm install --omit=dev || true

# 复制全部源码与启动脚本
COPY . .

# 平台会以 serverConfig.Port 注入 PORT 环境变量，代码监听该端口（process.env.PORT || 9000）
EXPOSE 3000

CMD ["node", "src/index.js"]
