import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { initDatabase } from './server/db.ts';
import { WsNotificationHub } from './server/ws.ts';
import { createApp } from './server/app.ts';

async function startServer() {
  const port = 3000;
  const db = initDatabase();

  const rootApp = express();
  const httpServer = http.createServer(rootApp);
  const wsHub = new WsNotificationHub(httpServer, db);

  const apiApp = createApp(db, wsHub);
  rootApp.use(apiApp);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
          path: '/__vite_hmr',
        },
        ws: {
          server: httpServer,
          path: '/__vite_hmr',
        },
        watch: null,
      },
      appType: 'spa',
    });
    rootApp.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    rootApp.use(express.static(distDir));
    rootApp.get('*', (req, res) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        res.status(404).json({ error: 'Маршрут не найден' });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`nekaLexi server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start nekaLexi server:', err);
  process.exit(1);
});
