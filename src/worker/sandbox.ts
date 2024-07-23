// @ts-ignore
import Xvfb from "xvfb";
import { launch, getStream } from "puppeteer-stream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import fs from 'fs';
import client from 'https';
import { Job, SandboxedJob } from 'bullmq';
import { Page } from "puppeteer-core";

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const width = 1920;
const height = 1080;

const redis = new Redis({
    port: redisPort,
    host: redisHost,
    maxRetriesPerRequest: null
});

function sleep (time: number) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

module.exports = async (job: SandboxedJob | Job) => {
    await streamMeeting(job);
};

function streamMeeting(job: SandboxedJob | Job) {

    const joinUrl = job.data.joinUrl;
    const pauseImageUrl = job.data.pauseImageUrl;
    const pauseImageFile = '/tmp/pause-image-'+job.id+'.jpg';
    const rtmpUrl = job.data.rtmpUrl;

    return new Promise<void>(async (resolve) => {
        job.log('Processing job '+ job.id);

        job.log('Downloading pause image from '+pauseImageUrl+' to '+pauseImageFile);

        await downloadImage(pauseImageUrl, pauseImageFile).then((filepath) => {
            job.log('Pause image downloaded to '+filepath);
        }).catch((error) => {
            job.log('Failed to download pause image: '+error);
        });

        job.log('Pause image downloaded');

        redis.subscribe("meeting-"+job.id, (err, count) => {
            if (err) {
                // Just like other commands, subscribe() can fail for some reasons,
                // ex network issues.
                throw new Error("Failed to subscribe: "+err.message);
            } else {
                // `count` represents the number of channels this client are currently subscribed to.
                job.log(
                    `Subscribed successfully! This client is currently subscribed to ${count} channels.`
                );
            }
        });

        redis.on("message", (channel, message) => {
            job.log(`Received ${message} from ${channel}`);
            const data = JSON.parse(message);
            if (data.action === "pause") {
                job.updateProgress({status: "pausing"});
            }
            if (data.action === "resume") {
                job.updateProgress({status: "resuming"});
            }
            if (data.action === "stop") {
                job.updateProgress({status: "stopping"});
            }
        });


        await job.updateProgress({status: "starting"});

        let xvfb = new Xvfb({
            displayNum: null,
            silent: true,
            xvfb_args: [
                "-screen",
                "0",
                `${width}x${height}x24`,
                "-ac",
                "-nolisten",
                "tcp",
                "-dpi",
                "96",
                "+extension",
                "RANDR",
            ],
        });

        const command = `xvfb-run -a --server-args="-screen 0 ${width}x${height}x24 -ac -nolisten tcp -dpi 96 +extension RANDR" /usr/bin/google-chrome`;

        const options = {
            headless: false,
            executablePath: "/usr/bin/google-chrome",
            args: [
                "--disable-infobars",
                "--no-sandbox",
                "--shm-size=2gb",
                "--disable-dev-shm-usage",
                "--start-fullscreen",
                `--window-size=${width},${height}`,
            ],
        };


        try {
            // Start streaming
            job.log('Started streaming');

            xvfb.startSync();
            const browser = await launch(options);
            const page = await browser.newPage();

            await page.goto(joinUrl);
            await page.setViewport({width, height});

            await page.locator('[data-test="listenOnlyBtn"]').setTimeout(10000).click();

            job.log("The streaming bot has joined the BBB session");
            job.log("Streaming has started...");

            await job.updateProgress({status: "running"});

            let ffmpegVideoconference: ChildProcessWithoutNullStreams | null = await streamVideoconference(job, page, rtmpUrl)
            let ffmpegPause: ChildProcessWithoutNullStreams | null = null;


            // @ts-ignore
            while (job.progress.status !== "stopping") {
                // @ts-ignore
                if(job.progress.status === "pausing"){
                    await job.updateProgress({status: "paused"});
                    job.log('Start pause image');
                    ffmpegPause = streamPauseImage(job, pauseImageFile, rtmpUrl);
                    job.log('Started pause image');
                    if(ffmpegVideoconference){
                        job.log('Stop video conf. stream');
                        const result = ffmpegVideoconference.kill('SIGKILL');
                        job.log('Stopped video conf. stream, result: '+result ? 'success' : 'failed');
                    }
                    else{
                        job.log('No video conf. stream to stop');
                    }
                }

                // @ts-ignore
                if(job.progress.status === "resuming"){
                    await job.updateProgress({status: "running"});
                    job.log('Start ffmpeg video conf.');
                    ffmpegVideoconference = await streamVideoconference(job, page, rtmpUrl);
                    job.log('Started ffmpeg video conf.');
                    if(ffmpegPause){
                        job.log('Stop pause image stream');
                        const result = ffmpegPause.kill('SIGKILL');
                        job.log('Stopped pause image stream, result: '+result ? 'success' : 'failed');
                    }
                    else{
                        job.log('No pause image stream to stop');
                    }
                }

                await sleep(1000);
            }

            await job.updateProgress({status: "stopped"});
            await browser.close();
            await xvfb.stopSync();
            if(ffmpegVideoconference){
                ffmpegVideoconference.kill('SIGKILL');
            }
            if (ffmpegPause){
                ffmpegPause.kill('SIGKILL');
            }


            resolve();
        }
        catch (error) {
            job.log('Failed to start streaming: '+JSON.stringify(error));
            // @ts-ignore
            job.log('Failed to start streaming: '+JSON.stringify(error?.message));
            // @ts-ignore
            job.log('Failed to start streaming: '+JSON.stringify(error?.stack));
            // @ts-ignore
            job.log('Failed to start streaming: '+JSON.stringify(error?.toString()));
        }
    });
}

async function streamVideoconference(job: SandboxedJob | Job, page: Page, rtmpUrl: string){
    const bbbStreamOptions = {
        audio: true,
        video: true,
        audioBitsPerSecond: 128000,
        videoBitsPerSecond: 2500000,
        frameSize: 30,
        ignoreMutedMedia: true,
        mimeType: 'video/webm;codecs=h264'
    }

    const ffmpeg = spawn('ffmpeg', [
        "-y", "-nostats",
        "-thread_queue_size", "4096",

        // FFmpeg will read input video from STDIN
        '-i', '-',

        // If we're encoding H.264 in-browser, we can set the video codec to 'copy'
        // so that we don't waste any CPU and quality with unnecessary transcoding.
        '-vcodec', 'copy',

        // use if you need for smooth youtube publishing. Note: will use more CPU
        // '-vcodec', 'libx264',
        // '-x264-params', 'keyint=120:scenecut=0',

        //No browser currently supports encoding AAC, so we must transcode the audio to AAC here on the server.
        '-acodec', 'aac',
        "-b:a", "160k",

        // remove background noise. You can adjust this values according to your need
        //'-af', 'highpass=f=200, lowpass=f=3000',

        // This option sets the size of this buffer, in packets, for the matching output stream
        "-max_muxing_queue_size", '99999',
        "-ar", "48000",
        "-threads", "0",
        "-b:v", "4000k",
        "-maxrate", "4000k",
        "-minrate", "2000k",
        "-bufsize", "8000k",
        "-g", "60",
        "-preset", "ultrafast",
        "-tune", "zerolatency",

        // FLV is the container format used in conjunction with RTMP
        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        rtmpUrl
    ]);

    // @ts-ignore
    const bbbStream = await getStream(page, bbbStreamOptions);
    bbbStream.pipe(ffmpeg.stdin);

    ffmpeg.on('close', (code, signal) => {
        job.log('FFmpeg video conf. child process closed, code ' + code + ', signal ' + signal);
        bbbStream.destroy();
    });

    ffmpeg.stdin.on('error', (e) => {
        job.log('FFmpeg video conf. STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        job.log('FFmpeg video conf. STDERR:'+ data.toString());
    });

   
     return ffmpeg;
}

function streamPauseImage(job: SandboxedJob | Job, imageFile: string, rtmpUrl: string){
    const ffmpeg = spawn('ffmpeg', [
        "-y", "-nostats",

        "-f", "image2",
        "-loop", "1",
        "-i", imageFile,
        "-re",

        "-f", "lavfi",
        "-i", "anullsrc",

        "-vf", "format=yuv420p", 

        '-vcodec', 'libx264',
        '-x264-params', 'keyint=120:scenecut=0',

        '-acodec', 'aac',
        "-b:a", "160k",

        // This option sets the size of this buffer, in packets, for the matching output stream
        "-max_muxing_queue_size", '99999',
        "-ar", "48000",
        "-threads", "0",
        "-b:v", "4000k",
        "-maxrate", "4000k",
        "-minrate", "2000k",
        "-bufsize", "8000k",
        "-g", "60",
        "-preset", "ultrafast",
        "-tune", "zerolatency",

        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        rtmpUrl
    ]);

    ffmpeg.on('close', (code, signal) => {
        job.log('FFmpeg pause image child process closed, code ' + code + ', signal ' + signal);
    });

    ffmpeg.stdin.on('error', (e) => {
        job.log('FFmpeg pause image STDIN Error'+ JSON.stringify(e));
    });

    ffmpeg.stderr.on('data', (data) => {
        job.log('FFmpeg pause image STDERR:'+ data.toString());
    });

    return ffmpeg;
}

function downloadImage(url: string, filepath: string) {
    return new Promise((resolve, reject) => {
        client.get(url, (res) => {
            if (res.statusCode === 200) {
                res.pipe(fs.createWriteStream(filepath))
                    .on('error', reject)
                    .once('close', () => resolve(filepath));
            } else {
                // Consume response data to free up memory
                res.resume();
                reject(new Error(`Request Failed With a Status Code: ${res.statusCode}`));

            }
        });
    });
}
