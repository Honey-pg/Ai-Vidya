import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export const gradingQueue = new Queue('submission-grading', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});
