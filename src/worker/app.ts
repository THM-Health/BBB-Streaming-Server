import Redis from 'ioredis';
import { Worker, SandboxedJob } from 'bullmq';
import * as path from "node:path";

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
