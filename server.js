const http = require('http');
const https = require('https');

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

    res.writeHead(proxyRes.statusCode, headers);

    const contentType = proxyRes.headers['content-type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    if (isSSE) {
      // Немедленно отправляем заголовки для потоковой передачи
      res.flushHeaders();

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

          // Обрабатываем строки с данными
          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6); // Убираем "data: "
            
            // Проверяем, не является ли это сигналом завершения
            if (jsonStr === '[DONE]') {
              res.write(line + '\n\n');
              return;
            }

            try {
              const data = JSON.parse(jsonStr);
              
              // ПРОВЕРЯЕМ НАЛИЧИЕ reasoning_content В ДЕЛЬТЕ
              if (data.choices && data.choices[0] && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                
                // Если есть reasoning_content, оборачиваем его в теги <thinking>
                if (delta.reasoning_content) {
                  const thinkingText = delta.reasoning_content;
                  
                  // Модифицируем delta: переносим reasoning_content в content с тегами
                  delta.content = `<thinking>${thinkingText}</thinking>`;
                  // Удаляем оригинальное поле, чтобы избежать дублирования
                  delete delta.reasoning_content;
                }
              }
              
              // Отправляем модифицированные данные
              res.write(`data: ${JSON.stringify(data)}\n\n`);
              
            } catch (e) {
              // Если не удалось распарсить, отправляем как есть
              res.write(line + '\n\n');
            }
          } else {
            // Другие строки отправляем как есть
            res.write(line + '\n\n');
          }
        });
      });

      proxyRes.on('end', () => {
        // Обрабатываем оставшийся буфер
        if (buffer.trim()) {
          res.write(buffer + '\n');
        }
        res.end();
      });

    } else {
      // ДЛЯ НЕСТРИМИНГОВЫХ ОТВЕТОВ (обычный JSON)
      let body = '';
      
      proxyRes.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          
          // Проверяем наличие reasoning_content в ответе
          if (data.choices && data.choices[0] && data.choices[0].message) {
            const message = data.choices[0].message;
            
            // Если есть reasoning_content и нет content, или reasoning_content нужно объединить
            if (message.reasoning_content) {
              const thinkingText = message.reasoning_content;
              
              // Оборачиваем в теги и добавляем в content
              if (message.content) {
                // Если content уже есть, добавляем размышления перед ним
                message.content = `<thinking>${thinkingText}</thinking>\n${message.content}`;
              } else {
                // Если content пуст, он становится размышлениями
                message.content = `<thinking>${thinkingText}</thinking>`;
              }
              
              // Удаляем оригинальное поле
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
