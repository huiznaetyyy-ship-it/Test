const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    // 1. Inject relaxed CORS headers allowing JanitorAI to talk to it
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // 2. Intercept browser pre-flight checks immediately
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 3. Forward incoming payloads straight to APInex
    const options = {
        hostname: 'api.apinex.bond',
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: 'api.apinex.bond' }
    };

    const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    req.pipe(proxyReq, { end: true });

    proxyReq.on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error: ' + err.message);
    });
});

server.listen(PORT, () => {
    console.log(`CORS Proxy active on port ${PORT}`);
});
