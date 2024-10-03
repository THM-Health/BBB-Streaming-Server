import express from 'express';
import { query } from 'express-validator';
import Redis from 'ioredis';
import {Queue} from "bullmq";
import { v4 as uuidv4 } from 'uuid';

const app = express();
const port = process.env.PORT || 3000;

const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;

app.use(express.json());

// Create a Redis client
const redis = new Redis({
    port: redisPort,
    host: redisHost,
    maxRetriesPerRequest: null
});

const streamQueue = new Queue('streams', { connection: redis });

app.get('/', (req, res) => {
    res.send('Hello Redis with Express.js and TypeScript!');
});


app.post('/:meetingId', async (req, res) => {

    /**
     * join link should have these attributes
     * 
     * userdata-bbb_hide_nav_bar=true
     * userdata-bbb_hide_actions_bar=true
     * userdata-bbb_show_public_chat_on_login=false
     * userdata-bbb_show_participants_on_login=false
     * userdata-bbb_ask_for_feedback_on_logout=true
     */

    const job = await streamQueue.add(
        'meeting',
        req.body,
        {
            jobId: req.params.meetingId,
            removeOnComplete: true
        }
    );
    res.json(job);
});

app.get('/:meetingId', async (req, res) => {
    const job = await streamQueue.getJob(req.params.meetingId);
    const logs = await streamQueue.getJobLogs(req.params.meetingId);

    if(job == null) {
        res.status(404).send('Job not found');
        return;
    }

    res.json({
        id: job.id,
        progress: job.progress,
        logs: logs
    });
});

app.post('/:meetingId/stop', async (req, res) => {
    const job = await streamQueue.getJob(req.params.meetingId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    // @ts-ignore
    if(job.progress?.status !== "running"){
        // @ts-ignore
        res.status(400).send('Stream is not running, status: ' + job.progress.status);
        return;
    }

    await redis.publish("meeting-"+job.id, JSON.stringify({action: "stop"}));

    res.status(200).send( 'Stopping');
});

app.post('/:meetingId/pause', async (req, res) => {
    const job = await streamQueue.getJob(req.params.meetingId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    // @ts-ignore
    if(job.progress?.status !== "running"){
        // @ts-ignore
        res.status(400).send('Stream is not running, status: ' + job.progress.status);
        return;
    }

    await redis.publish("meeting-"+job.id, JSON.stringify({action: "pause"}));

    res.status(200).send( 'Pausing');
});

app.post('/:meetingId/resume', async (req, res) => {
    const job = await streamQueue.getJob(req.params.meetingId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    // @ts-ignore
    if(job.progress?.status !== "paused"){
        // @ts-ignore
        res.status(400).send('Stream is not paused, status: ' + job.progress.status);
        return;
    }

    await redis.publish("meeting-"+job.id, JSON.stringify({action: "resume"}));

    res.status(200).send( 'Resuming');
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

export default app;
