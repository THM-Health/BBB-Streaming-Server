import Xvfb from "xvfb";
import { launch, getStream } from "puppeteer-stream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import fs from 'fs';
import client from 'https';

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const width = 1920;
const height = 1080;

const redis = new Redis({
    port: redisPort,
    host: redisHost,
    maxRetriesPerRequest: null
});

function sleep (time) {
    return new Promise((resolve) => setTimeout(resolve, time));
}

module.exports = async (job) => {
    await streamMeeting(job);
};

async function streamMeeting(job) {

    const joinUrl = job.data.joinUrl;
    const pauseImageUrl = job.data.pauseImageUrl;
    const pauseImageFile = 'pause-image-'+job.id+'.jpg';
    const rtmpUrl = job.data.rtmpUrl;

    return new Promise(async (resolve) => {
        job.log('Processing job', job.id);

        job.log('Downloading pause image');

        await downloadImage(pauseImageUrl, pauseImageFile);

        redis.subscribe("meeting-"+job.id, (err, count) => {
            if (err) {
                // Just like other commands, subscribe() can fail for some reasons,
                // ex network issues.
                throw new Error("Failed to subscribe: %s", err.message);
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
                "--app="+joinUrl,
                `--window-size=${width},${height}`,
            ],
        };


        try {
            // Start streaming
            job.log('Started streaming');

            xvfb.startSync();
            const browser = await launch(options);
            const pages = await browser.pages();
            const page = pages[0];

            job.log("The streaming bot has joined the BBB session");
            job.log("Streaming has started...");

            await job.updateProgress({status: "running"});

            const bbbStreamOptions = {
                audio: true,
                video: true,
                audioBitsPerSecond: 128000,
                videoBitsPerSecond: 2500000,
                frameSize: 30,
                ignoreMutedMedia: true,
                mimeType: 'video/webm;codecs=h264'
            }

            // @ts-ignore
            const bbbStream = await getStream(page, bbbStreamOptions);

            let ffmpegVideoconference;
            let ffmpegPause;

            // On stream data  write it to ffmpeg stdin
            bbbStream.on('data', (chunk) => {
                if (ffmpegVideoconference) {
                    ffmpegVideoconference.stdin.write(chunk);
                }
            });

            ffmpegVideoconference = streamVideoconference(job, rtmpUrl);

            while (job.progress.status !== "stopping") {
                if(job.progress.status === "pausing"){
                    await job.updateProgress({status: "paused"});
                    ffmpegPause = streamPauseImage(job, pauseImageUrl, rtmpUrl);
                    if(ffmpegVideoconference){
                        ffmpegVideoconference.kill('SIGINT');
                    }
                }

                if(job.progress.status === "resuming"){
                    await job.updateProgress({status: "running"});
                    ffmpegVideoconference = streamVideoconference(job, rtmpUrl);
                    if(ffmpegPause){
                        ffmpegPause.kill('SIGINT');
                    }
                }

                await sleep(1000);
            }

            await job.updateProgress({status: "stopped"});
            await browser.close();
            await xvfb.stopSync();
            if(ffmpegVideoconference){
                ffmpegVideoconference.kill('SIGINT');
            }
            if (ffmpegPause){
                ffmpegPause.kill('SIGINT');
            }


            resolve();
        }
        catch (error) {
            job.error('Failed to start streaming', error);
        }
    });
}

function streamVideoconference(job, rtmpUrl){
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
    ])

    ffmpeg.on('close', (code, signal) => {
        job.log('FFmpeg child process closed, code ' + code + ', signal ' + signal);
    });

    ffmpeg.stdin.on('error', (e) => {
        job.log('FFmpeg STDIN Error', e);
    });

    ffmpeg.stderr.on('data', (data) => {
        job.log('FFmpeg STDERR:', data.toString());
    });

    return ffmpeg;
}

function streamPauseImage(job, imageUrl, rtmpUrl){
    const ffmpeg = spawn('ffmpeg', [
        "-f", "image2",
        "-loop", "1",
        "-i", "input.jpg",
        "-re",
        "-f", "lavfi",
        "-i", "anullsrc",
        "-vf", "format=yuv420p",
        "-c:v", "libx264",
        "-b:v", "2000k",
        "-maxrate", "2000k",
        "-bufsize", "4000k",
        "-g", "50",
        "-c:a", "aac",
        "-f", "flv",
        rtmpUrl
    ]);

    ffmpeg.on('close', (code, signal) => {
        job.log('FFmpeg child process closed, code ' + code + ', signal ' + signal);
    });

    ffmpeg.stdin.on('error', (e) => {
        job.log('FFmpeg STDIN Error', e);
    });

    ffmpeg.stderr.on('data', (data) => {
        job.log('FFmpeg STDERR:', data.toString());
    });

    return ffmpeg;
}

function downloadImage(url, filepath) {
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
