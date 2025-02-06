import Redis from 'ioredis';
import { Worker, Job } from 'bullmq';
import * as path from "node:path";
import axios from 'axios';
const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;
const concurrency: number = Number(process.env.CONCURRENCY) || 1;

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
    concurrency: concurrency
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
  const status: string = progress.status;
  // @ts-ignore
  const fps: number = progress.fps;
  // @ts-ignore
  const bitrate: number = progress.bitrate;

  console.log(`Job ${job.id} is ${status}`);

  sendStatusToWebhook(job, status, fps, bitrate);
});

function sendStatusToWebhook(job: Job, status: string = null, fps: number = null, bitrate: number = null){
  if(!job.data.webhookUrl)
    return;

    

    const data = {
      job: job.id,
      status,
      fps,
      bitrate
    };

    console.log(job.data.webhookUrl+" "+JSON.stringify(data));

    //const webhookUrl = "https://httpdump.app/dumps/9e0407e3-2982-4bb0-88da-985be680ce7e";//job.data.webhookUrl;
    const webhookUrl = job.data.webhookUrl;

    axios.post(webhookUrl, data ).catch((error) => {
      console.log(error);
      if (error.response) {
        console.error('Webhook for '+job.id+' status '+status+' failed with status code '+error.response.status);
      }
      else{
        console.error('Webhook for '+job.id+' status '+status+' failed', error.code);
      }
  });
}