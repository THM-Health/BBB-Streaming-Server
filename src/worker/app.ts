import Redis from 'ioredis';
import { Worker, Job } from 'bullmq';
import * as path from "node:path";
import { BBBLiveStream } from './BBBLiveStream';

const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;

// Create a Redis client
const redis = new Redis({
    port: redisPort,
    host: redisHost,
    maxRetriesPerRequest: null
});


const processorFile = path.join(__dirname, 'sandbox.js');
const worker = new Worker('streams', processorFile,{ connection: redis });

worker.on("error", (error) => {
    console.error(error);
  });
  worker.on("completed", (job: Job, returnValue: any) => {
    console.log(`Job ${job.id} completed with return value: ${returnValue}`);
  });
  worker.on("failed", (job: Job | undefined, error: Error) => {
    console.error(`Job ${job?.id} failed with error: ${error}`);
  });