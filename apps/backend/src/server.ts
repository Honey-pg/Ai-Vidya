import http from 'http';
import app from './app';
import { connectDB } from './config/db';
import { env } from './config/env';
import { initSocket } from './socket';

const server = http.createServer(app);

initSocket(server);

async function start(): Promise<void> {
  await connectDB();
  await import('./queues/worker');
  await import('./queues/gradingWorker');

  const port = Number(env.PORT) || 4000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`API listening on http://127.0.0.1:${port}`);
    console.log(`AI Provider: ${env.AI_PROVIDER}`);
  });
}

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
