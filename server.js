const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Перезапись пути для APInex
  let targetPath = req.url;
  if (targetPath === '/chat/completions') {
    targetPath = '/v1/chat/completions';
  }

  const options = {
    hostname: 'api.apinex.bond',
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: 'api.apinex.bond',
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // Копируем заголовки, удаляя CORS-дубликаты
    const headers = { ...proxyRes.headers };
    delete headers['access-control-allow-origin'];
    delete headers['access-control-allow-methods'];
    delete headers['access-control-allow-headers'];

    res.writeHead(proxyRes.statusCode, headers);

    const contentType = proxyRes.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    if (isSSE) {
      // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: немедленно отправляем заголовки,
      // чтобы браузер не решил, что соединение не установлено.
      res.flushHeaders();
    }

    // Просто передаём поток как есть. SSE-комментарии (`: ping`)
    // JanitorAI умеет игнорировать, а ручная фильтрация только ломает формат.
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Ошибка прокси-запроса:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy Error: ' + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`CORS Proxy активен на порту ${PORT}`);
});
