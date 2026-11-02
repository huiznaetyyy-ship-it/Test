const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // CORS заголовки
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

    // Если это поток, принудительно устанавливаем правильный Content-Type
    const contentType = proxyRes.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    if (isSSE) {
      headers['content-type'] = 'text/event-stream; charset=utf-8';
    }

    res.writeHead(proxyRes.statusCode, headers);

    if (isSSE) {
      // КРИТИЧЕСКИ ВАЖНО: немедленно отправляем заголовки, чтобы установить соединение
      res.flushHeaders();
      // Отправляем начальный комментарий, чтобы некоторые прокси начали передачу
      res.write(': stream-start\n\n');

      const decoder = new StringDecoder('utf8');
      let buffer = '';

      proxyRes.on('data', (chunk) => {
        buffer += decoder.write(chunk);
        // Обрабатываем поток построчно, как того требует SSE
        let lines = buffer.split('\n');
        buffer = lines.pop(); // Оставляем последнюю неполную строку в буфере

        lines.forEach((line) => {
          const trimmed = line.trim();
          // Пропускаем пустые строки и служебные комментарии SSE
          if (trimmed === '' || trimmed.startsWith(':')) {
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') {
              res.write('data: [DONE]\n\n');
              return;
            }

            try {
              const data = JSON.parse(jsonStr);
              // Обрабатываем reasoning_content в потоке
              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.reasoning_content) {
                  // Оборачиваем в теги <think>
                  delta.content = `<think>${delta.reasoning_content}</think>`;
                  delete delta.reasoning_content;
                }
              }
              // Отправляем модифицированные данные как корректное SSE-событие
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              // Если парсинг не удался, отправляем строку как есть
              res.write(line + '\n\n');
            }
          } else {
            // Другие строки (например, event:) отправляем как есть
            res.write(line + '\n\n');
          }
        });
      });

      proxyRes.on('end', () => {
        // Обрабатываем остаток буфера
        if (buffer.trim()) {
          res.write(buffer + '\n');
        }
        res.end();
      });

    } else {
      // Для нестриминговых ответов (обычный JSON)
      let body = '';
      proxyRes.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const message = data.choices[0].message;
            if (message.reasoning_content) {
              const thinkingText = message.reasoning_content;
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
