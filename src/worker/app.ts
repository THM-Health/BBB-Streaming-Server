import Redis from 'ioredis';
import { Worker, Job, JobProgress } from 'bullmq';
import * as path from "node:path";
import getenv from 'getenv';

const redisHost = getenv('REDIS_HOST', 'redis');
const redisPort = getenv.int('REDIS_PORT', 6379);
const redisDB = getenv.int('REDIS_DB', 0);
const redisPassword = getenv('REDIS_PASSWORD', '');
const redisUsername = getenv('REDIS_USERNAME', '');
const redisTLS = getenv.bool('REDIS_TLS', false);
const concurrency = getenv.int('CONCURRENCY', 1);
const containerID = getenv('HOSTNAME');
const closeOnFinish = getenv.bool('CLOSE_ON_FINISH', false);

console.log('Container ID: '+containerID);

// Create a Redis client
const redis = new Redis({
    tls: redisTLS ? {} : undefined,
    port: redisPort,
    host: redisHost,
    db: redisDB,
    password: redisPassword,
    username: redisUsername,
    maxRetriesPerRequest: null
});


const processorFile = path.join(__dirname, 'sandbox.js');
const worker = new Worker('streams', processorFile,
  { connection: redis,
    concurrency: concurrency,
    name: containerID
  });

worker.on("error", (error) => {
  console.error(error);
});
worker.on("active", (job, prev) => {
  console.log(`Job ${job.id} active from ${prev}`);
});
worker.on("completed", (job: Job, returnValue: any) => {
  if(closeOnFinish){
    worker.close();
  }
  console.log(`Job ${job.id} completed`);
  job.updateProgress({status: 'stopped', fps: null, bitrate: null});
});
worker.on("failed", (job: Job | undefined, error: Error) => {
  console.error(`Job ${job?.id} failed with error: ${error}`);
  job.updateProgress({status: 'failed', fps: null, bitrate: null});
});
worker.on("progress", (job: Job, progress: JobProgress) => {
 
  // @ts-ignore
  const status: string = progress.status;

  console.log(`Job ${job.id} is ${status}`);
});
worker.on("closing", () => {
  console.log('Waiting for all jobs to finish');
});
worker.on("closed", () => {
  console.log('All jobs finished');
  process.exit(0);
});

async function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  await worker.close();
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);