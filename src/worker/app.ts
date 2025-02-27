import Redis from 'ioredis';
import { Worker, Job } from 'bullmq';
import * as path from "node:path";
import getenv from 'getenv';

const redisHost = getenv('REDIS_HOST', 'redis');
const redisPort = getenv.int('REDIS_PORT', 6379);
const concurrency = getenv.int('CONCURRENCY', 1);
const containerID = getenv('HOSTNAME');

console.log('Container ID: '+containerID);

// Create a Redis client
const redis = new Redis({
    port: redisPort,
    host: redisHost,
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
  console.log(`Job ${job.id} completed`);
  job.updateProgress({status: 'stopped', fps: null, bitrate: null});
});
worker.on("failed", (job: Job | undefined, error: Error) => {
  console.error(`Job ${job?.id} failed with error: ${error}`);
  job.updateProgress({status: 'failed', fps: null, bitrate: null});
});
worker.on("progress", (job: Job, progress: number | object) => {
 
  // @ts-ignore
  const status: string = progress.status;
  // @ts-ignore
  const fps: number = progress.fps;
  // @ts-ignore
  const bitrate: number = progress.bitrate;

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