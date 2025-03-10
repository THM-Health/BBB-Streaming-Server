import express from 'express';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import {Queue} from "bullmq";
import { checkSchema, validationResult, matchedData } from 'express-validator';
import { createHash } from 'crypto';
import { URL } from 'node:url';
import getenv from 'getenv';

const app = express();
const port = process.env.PORT || 3000;

const redisHost = getenv('REDIS_HOST', 'redis');
const redisPort = getenv.int('REDIS_PORT', 6379);
const redisDB = getenv.int('REDIS_DB', 0);
const redisPassword = getenv('REDIS_PASSWORD', '');
const redisUsername = getenv('REDIS_USERNAME', '');
const redisTLS = getenv.bool('REDIS_TLS', false);
const failedJobAttempts = getenv.int('FAILED_JOB_ATTEMPTS', 3);
const keepCompletedJobsDuration = getenv.int('KEEP_COMPLETED_JOBS_DURATION', 60*60);
const keepFailedJobsDuration = getenv.int('KEEP_FAILED_JOBS_DURATION', 60*60);

app.use(express.json());

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

const streamQueue = new Queue('streams', { connection: redis });

app.get('/health', async (req, res) => {
    try {
        // Check Redis connection
        const redisPing = await redis.ping();

        // Determine the number of workers
        const workerCount = await streamQueue.getWorkersCount();

        const waitingCount = await streamQueue.getWaitingCount();
        const runningCount = await streamQueue.getActiveCount();

        if (redisPing !== 'PONG' || workerCount < 1) {
            return res.status(503).json({
                workerCount,
                waitingCount,
                runningCount,
            });
        }

        res.status(200).json({
            workerCount,
            waitingCount,
            runningCount,
        });
    } catch (error: any) {
        res.status(500).json({
            error: error.toString(),
        });
    }
});

app.get('/metrics', async (req, res) => {
    try {
        const metrics = await streamQueue.exportPrometheusMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
    } catch (err: any) {
        res.status(500).send(err.message);
    }
});

const createSchema = {
    joinUrl: {
        notEmpty: true
    },
    pauseImageUrl: {
        optional: true,
    },
    rtmpUrl: {
        notEmpty: true
    }
  
};


app.post('/', checkSchema(createSchema, ['body']), async (req: Request, res: Response) => {

    /**
     * join link should have these attributes
     * 
     * userdata-bbb_hide_nav_bar=true
     * userdata-bbb_hide_actions_bar=true
     * userdata-bbb_show_public_chat_on_login=false
     * userdata-bbb_show_participants_on_login=false
     * userdata-bbb_ask_for_feedback_on_logout=true
     */

    const result = validationResult(req);
    if (!result.isEmpty()) {
        res.status(422).json({ errors: result.array() });
        return;
    }

    const data = matchedData(req);

    let joinUrl: URL;
    try{
        joinUrl = new URL(data.joinUrl);
    }
    catch(typeError){
        res.status(422).json({
            errors: [
                {
                    type: "field",
                    msg: "Invalid url",
                    path: "joinUrl",
                    location: "body"
                }
            ]
        });
        return;
    }

    const host = joinUrl.host;
    const params = joinUrl.searchParams;
    const meetingId = params.get('meetingID');

    if(meetingId == null){
        res.status(422).json({
            errors: [
                {
                    type: "field",
                    msg: "Meeting ID not found in join url",
                    path: "joinUrl",
                    location: "body"
                }
            ]
        });
        return;
    }

    const jobId = createHash('sha256').update(meetingId+"@"+host).digest('hex');

    const jobData = {
        joinUrl: data.joinUrl,
        pauseImageUrl: data.pauseImageUrl,
        rtmpUrl: data.rtmpUrl,
    };

    let job = await streamQueue.getJob(jobId);

    if(job !== undefined && await job.isFailed()){
        console.log('Retrying failed job' + job.id);
        await job.retry();
    }
    else{
        if(job !== undefined && await job.isCompleted()){
            console.log('Restarting stopped job' + job.id);
            await job.remove();
        }

        job = await streamQueue.add(
            'meeting',
            jobData,
            {
                jobId: jobId,
                attempts: failedJobAttempts,
                removeOnComplete: {
                    age: keepCompletedJobsDuration
                },
                removeOnFail: {
                    age: keepFailedJobsDuration
                },
            }
        );
    }

    
    job.updateProgress({status: "queued", fps: 0, bitrate: 0});
    res.status(201).json({
        id: job.id,
        progress: job.progress,
    });
});

app.get('/:jobId', async (req, res) => {
    const job = await streamQueue.getJob(req.params.jobId);
    //const logs = await streamQueue.getJobLogs(req.params.jobId);

    if(job == null) {
        res.status(404).send('Job not found');
        return;
    }

    const state = await job.getState();

    res.status(200).json({
        id: job.id,
        progress: job.progress,
        state: state
    });
});

app.post('/:jobId/stop', async (req, res) => {
    const job = await streamQueue.getJob(req.params.jobId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    if(await job.isWaiting()){
        try{
            const id = job.id;
            await job.remove();
            res.status(202).json({
                id,
                progress: {status: "stopped", fps: 0, bitrate: 0},
            });
            return;
        }
        catch(error){
            console.error(error);
        }
    }
    // @ts-ignore
    if(! (job.progress?.status == "running" || job.progress?.status== "paused" || job.progress?.status == "resuming" || job.progress?.status == "pausing")){
        // @ts-ignore
        res.status(400).json({
            id: job.id,
            progress: job.progress,
        });
        return;
    }

    job.updateProgress({status: "stopping", fps: 0, bitrate: 0});
    await redis.publish("job-"+job.id, JSON.stringify({action: "stop"}));

    res.status(202).json({
        id: job.id,
        progress: job.progress,
    });
});

app.post('/:jobId/pause', async (req, res) => {
    const job = await streamQueue.getJob(req.params.jobId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    // @ts-ignore
    if(job.progress?.status !== "running"){
        // @ts-ignore
        res.status(400).json({
            id: job.id,
            progress: job.progress,
        });
        return;
    }

    job.updateProgress({status: "pausing", fps: 0, bitrate: 0});
    await redis.publish("job-"+job.id, JSON.stringify({action: "pause"}));


    res.status(202).json({
        id: job.id,
        progress: job.progress,
    });
});

app.post('/:jobId/resume', async (req, res) => {
    const job = await streamQueue.getJob(req.params.jobId);

    if(job == null) {
        res.status(404).send('No stream running for this meeting');
        return;
    }

    // @ts-ignore
    if(job.progress?.status !== "paused"){
        // @ts-ignore
        res.status(400).json({
            id: job.id,
            progress: job.progress,
        });
        return;
    }

    job.updateProgress({status: "resuming", fps: 0, bitrate: 0});
    await redis.publish("job-"+job.id, JSON.stringify({action: "resume"}));

    res.status(202).json({
        id: job.id,
        progress: job.progress,
    });
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

export default app;
