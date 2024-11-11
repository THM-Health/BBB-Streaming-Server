import Redis from 'ioredis';
import { Worker, Job } from 'bullmq';
import * as path from "node:path";
import axios from 'axios';
const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;

// Create a Redis client
const redis = new Redis({
    port: redisPort,
    host: redisHost,
    maxRetriesPerRequest: null
});


const processorFile = path.join(__dirname, 'sandbox.js');
const worker = new Worker('streams', processorFile,
  { connection: redis,
    removeOnComplete: { count: 0 },
    concurrency: 50
  });

worker.on("error", (error) => {
  console.error(error);
});
worker.on("active", (job, prev) => {
  console.log(`Job ${job.id} active from ${prev}`);
});
worker.on("completed", (job: Job, returnValue: any) => {
  console.log(`Job ${job.id} completed`);
  sendStatusToWebhook(job, 'stopped');
  //job.remove();
});
worker.on("failed", (job: Job | undefined, error: Error) => {
  console.error(`Job ${job?.id} failed with error: ${error}`);
  sendStatusToWebhook(job, 'failed');
});
worker.on("progress", (job: Job, progress: number | object) => {
  // @ts-ignore
  console.log(`Job ${job.id} is ${progress.status}`);

  // @ts-ignore
  const status: string = progress.status;

  sendStatusToWebhook(job, status);
});

function sendStatusToWebhook(job: Job, status: string){
  try{
    axios.post(job.data.webhookUrl, {
      job: job.id,
      status
    });
  }
  catch(exception) {
    console.error(exception);
  }
}