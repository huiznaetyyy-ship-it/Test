const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // 1. CORS-заголовки для нашего прокси
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 2. Перезапись пути для APInex
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
    // 3. Копируем заголовки от APInex, УДАЛЯЯ его CORS-заголовки,
    //    чтобы избежать дублирования с нашими.
    const headers = { ...proxyRes.headers };
    delete headers['access-control-allow-origin'];
    delete headers['access-control-allow-methods'];
    delete headers['access-control-allow-headers'];

    // 4. Отправляем заголовки клиенту
    res.writeHead(proxyRes.statusCode, headers);

    const contentType = proxyRes.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    if (isSSE) {
      // 5. КРИТИЧЕСКИ ВАЖНО: немедленно отправляем заголовки в сокет.
      //    Это предотвращает "Network error" из-за таймаута.
      res.flushHeaders();

      // 6. Отправляем начальный комментарий, чтобы некоторые прокси
      //    немедленно начали передачу потока, не дожидаясь данных.
      res.write(': stream-start\n\n');

      let buffer = '';

      proxyRes.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Оставляем неполную строку в буфере

        lines.forEach((line) => {
          const trimmed = line.trim();
          // Пропускаем пустые строки и служебные комментарии SSE
          if (trimmed === '' || trimmed.startsWith(':')) {
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            // Проверяем на сигнал завершения
            if (jsonStr === '[DONE]') {
              res.write(line + '\n\n');
              return;
            }

            try {
              const data = JSON.parse(jsonStr);
              
              // 7. Обрабатываем reasoning_content в потоке
              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.reasoning_content) {
                  // Оборачиваем в ПРАВИЛЬНЫЕ теги <think>
                  delta.content = `<think>${delta.reasoning_content}</think>`;
                  delete delta.reasoning_content;
                }
              }
              
              // Отправляем модифицированные данные как корректное SSE-событие
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              // Если не удалось распарсить, отправляем как есть
              res.write(line + '\n\n');
            }
          } else {
            // Другие строки (например, event:, id:) отправляем как есть
            res.write(line + '\n\n');
          }
        });
      });

      proxyRes.on('end', () => {
        if (buffer.trim()) {
          res.write(buffer + '\n');
        }
        res.end();
      });

    } else {
      // 8. Обработка НЕ-потоковых (обычных JSON) ответов
      let body = '';
      proxyRes.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          
          // Обрабатываем reasoning_content в обычном ответе
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const message = data.choices[0].message;
            if (message.reasoning_content) {
              const thinkingText = message.reasoning_content;
              // Оборачиваем в ПРАВИЛЬНЫЕ теги <think> и объединяем с контентом
              if (message.content) {
                message.content = `<think>${thinkingText}</think>\n${message.content}`;
              } else {
                message.content = `<think>${thinkingText}</think>`;
              }
              delete message.reasoning_content;
            }
          }
          
          res.write(JSON.stringify(data));
        } catch (e) {
          // Если не удалось распарсить, отправляем как есть
          res.write(body);
        }
        res.end();
      });
    }
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
  console.log(`CORS Proxy с поддержкой reasoning активен на порту ${PORT}`);
});
