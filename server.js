const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // 1. Устанавливаем НАШИ CORS-заголовки, чтобы избежать дублирования
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 2. Немедленно отвечаем на preflight-запросы браузера
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 3. Перезаписываем путь: JanitorAI -> /chat/completions, APInex -> /v1/chat/completions
  let targetPath = req.url;
  if (targetPath === '/chat/completions') {
    targetPath = '/v1/chat/completions';
  }

  const options = {
    hostname: 'api.apinex.bond',
    path: targetPath, // Используем исправленный путь
    method: req.method,
    headers: {
      ...req.headers,
      host: 'api.apinex.bond',
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    // 4. Копируем заголовки от APInex, но УДАЛЯЕМ его CORS-заголовки,
    //    чтобы не дублировать наши собственные.
    const headers = { ...proxyRes.headers };
    delete headers['access-control-allow-origin'];
    delete headers['access-control-allow-methods'];
    delete headers['access-control-allow-headers'];

    res.writeHead(proxyRes.statusCode, headers);

    // 5. Обрабатываем поток SSE, чтобы отфильтровать служебные строки
    const contentType = proxyRes.headers['content-type'] || '';
    if (contentType.includes('text/event-stream')) {
      let buffer = '';
      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString();
        // Обрабатываем поток построчно
        let lines = buffer.split('\n');
        buffer = lines.pop(); // Оставляем последнюю неполную строку в буфере

        lines.forEach((line) => {
          // Пропускаем пустые строки и служебные комментарии SSE (начинаются с ":")
          if (line.trim() !== '' && !line.startsWith(':')) {
            res.write(line + '\n');
          }
        });
      });

      proxyRes.on('end', () => {
        // Отправляем оставшийся буфер, если он есть, и завершаем поток
        if (buffer.trim() !== '' && !buffer.startsWith(':')) {
          res.write(buffer + '\n');
        }
        res.end();
      });
    } else {
      // Если ответ не потоковый, просто передаем его как есть
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Ошибка прокси-запроса:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy Error: ' + err.message);
  });

  // Передаем тело исходного запроса в прокси-запрос
  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(`CORS Proxy активен на порту ${PORT}`);
});
