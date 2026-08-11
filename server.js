const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', socket => {
  console.log('client connected', socket.id);

  socket.on('join', ({ room }) => {
    if (room) socket.join(room);
    console.log('socket joined', room || socket.id);
  });

  socket.on('user_message', ({ room, text }) => {
    console.log('user_message', { room, text });
    // 保存用户消息到 DB 的位置（此 demo 省略），并演示流式返回
    const chunks = [
      '正在思考...',
      '处理结果：',
      JSON.stringify({ scenario: { table: 'orders', columns: [{ name: 'id', type: 'integer' }, { name: 'amount', type: 'float' }] } }, null, 2)
    ];

    const target = room || socket.id;
    let i = 0;
    const t = setInterval(() => {
      if (i < chunks.length) {
        io.to(target).emit('message_chunk', { text: chunks[i] });
        i++;
      } else {
        clearInterval(t);
        io.to(target).emit('message_done', { content: chunks.join('') });
      }
    }, 300);
  });

  socket.on('disconnect', () => console.log('client disconnected', socket.id));
});

app.post('/api/conversations', (req, res) => {
  // 最小 demo：返回固定会话 id
  res.json({ id: 'conv_demo_1' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
