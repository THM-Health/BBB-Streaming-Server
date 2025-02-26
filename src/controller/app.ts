import express from 'express';
import { Request, Response } from 'express';
import Redis from 'ioredis';
import {Queue} from "bullmq";
import { checkSchema, validationResult, matchedData } from 'express-validator';
import { createHash } from 'crypto';
import { URL } from 'node:url';

const app = express();
const port = process.env.PORT || 3000;

const redisHost: string = process.env.REDIS_HOST || 'redis';
const redisPort: number = Number(process.env.REDIS_PORT) || 6379;
const failedJobAttempts: number = Number(process.env.FAILED_JOB_ATTEMPTS) || 3;
const keepCompletedJobsDuration: number = Number(process.env.KEEP_COMPLETED_JOBS_DURATION) || 60*60;
const keepFailedJobsDuration: number = Number(process.env.KEEP_FAILED_JOBS_DURATION) || 60*60;

app.use(express.json());

// Create a Redis client
const redis = new Redis({
    port: redisPort,
    host: redisHost,
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

        const worker = await streamQueue.getWorkers();
        // Assiciated array with worker name as key and value of active jobs as value
        let workerList: {[key: string]: number} = {};
        for (const [i, value] of worker.entries()) {
            const workerName = value.rawname.split(':').pop();
            if(workerName === undefined)
                continue;

            workerList[workerName] = 0
        };

        // sort the workers by key
        workerList = Object.keys(workerList).sort().reduce((acc, key) => {
            // @ts-ignore
            acc[key] = workerList[key];
            return acc;
        }, {});
        



        const runningJobs = await streamQueue.getActive();
        for (const [i, value] of runningJobs.entries()) {
            workerList[value.processedBy] += 1;
        };

        const queueStatus = await streamQueue.isPaused() ? 'paused' : 'running';


        res.status(200).json({
            queueStatus,
            workerCount,
            waitingCount,
            runningCount,
            workerList,
        });
    } catch (error: any) {
        res.status(500).json({
            error: error.toString(),
        });
    }
});

// Pause queue
app.get('/pause', async (req, res) => {
    try {
        await streamQueue.pause();
        res.status(200).send('Queue paused');
    } catch (error: any) {
        res.status(500).send(error.toString());
    }
});

// Resume queue
app.get('/resume', async (req, res) => {
    try {
        await streamQueue.resume();
        res.status(200).send('Queue resumed');
    } catch (error: any) {
        res.status(500).send(error.toString());
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

    // @ts-ignore
    if(job.progress?.status !== "running" && job.progress?.status !== "paused" ){
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
