import { launch, getStream, getStreamOptions } from "./PuppeteerStream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import { SandboxedJob, UnrecoverableError } from 'bullmq';
import { Browser, Page } from "puppeteer-core";
import getenv from 'getenv';
import pino from 'pino';
import { format }from 'node:util';

const redisHost = getenv('REDIS_HOST', 'redis');
const redisPort = getenv.int('REDIS_PORT', 6379);
const redisDB = getenv.int('REDIS_DB', 0);
const redisPassword = getenv('REDIS_PASSWORD', '');
const redisUsername = getenv('REDIS_USERNAME', '');
const redisTLS = getenv.bool('REDIS_TLS', false);
const ffmpegMetricsInterval = getenv.int('FFMPEG_METRICS_INTVL', 5);
const ffmpegMetricsAvgLength = getenv.int('FFMPEG_METRICS_AVG_LEN', 10);
const ffmpegCRF = getenv.int('FFMPEG_CRF', 23).toString();
const ffmpegBitrate = getenv.int('FFMPEG_BITRATE', 10);
const jsonLogs = getenv.bool('JSON_LOGS', true);

const width = 1920;
const height = 1080;

    const logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: !jsonLogs ? {
          target: 'pino-pretty',
          options: {
            colorize: true
          }
        } : undefined,
    });
export class BBBLiveStream{

    redis: Redis;
    job: SandboxedJob;
    joinUrl: string;
    pauseImageUrl: string;
    rtmpUrl: string;

    rtmpStream: ChildProcessWithoutNullStreams | undefined;
    videoConferenceStream: ChildProcessWithoutNullStreams | undefined;
    pauseImageStream: ChildProcessWithoutNullStreams | undefined;

    browser: Browser | undefined;
    page: Page | undefined;

    showPauseImage: boolean = false;
    streamEnded: (() => void) | undefined;
    
    bbbStream: any;
    closing: boolean = false;
    status: string;

    ffmpegError: string;

    constructor(job: any){
        this.job = job;
        this.joinUrl = job.data.joinUrl;
        this.pauseImageUrl = job.data.pauseImageUrl;
        this.rtmpUrl = job.data.rtmpUrl;
    
        this.redis = new Redis({
            tls: redisTLS ? {} : undefined,
            port: redisPort,
            host: redisHost,
            db: redisDB,
            password: redisPassword,
            username: redisUsername,
            maxRetriesPerRequest: null
        });
    }

    async updateProgress(status: string, fps: number = null, bitrate: number = null){
        this.status = status;
        return await this.job.updateProgress({ status, fps, bitrate });
    }

    handleRedisMessages() {
        this.redis.subscribe("job-"+this.job.id, (err) => {
            if (err) {
                this.stopStream();
                throw new Error("Failed to subscribe to redis control ws: "+err.message);
            } else {
                logger.debug(`Connected to redis control ws.`);
            }
        });

        this.redis.on("message", async(channel, message) => {
            logger.debug(`Received ${message} from ${channel}`);
            const data = JSON.parse(message);

            if (data.action === "pause") {
                logger.info("Pause command received");
                this.pause();
            }

            if (data.action === "resume") {
                logger.info("Resume command received");
                this.resume();
            }

            if (data.action === "stop") {
                logger.info("Stop command received");
                this.stopStream().then(() => {
                    logger.info("Stream ended successfully");
                    this.streamEnded();
                })
            }
        });
    }

    async openBBBMeeting(){
        const options = {
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: { width, height:height },
            args: [
                '--no-zygote',
                '--no-sandbox',
                '--start-fullscreen',
                '--disable-gpu',
                '--disable-setuid-sandbox',
                '--headless=new',
            ],
            closeDelay: 100
        };

        this.browser = await launch(options);

        this.page = await this.browser.newPage();

        await this.page.goto(this.joinUrl);

        try{
            await this.page.locator('[data-test="listenOnlyBtn"], [data-test="helpListenOnlyBtn"]').setTimeout(30000).click();
        }
        catch(error){
            logger.error("Failed to find listen only button");
            return false;
        }

        const bbbStreamOptions: getStreamOptions = {
            audio: true,
            video: true,
            videoConstraints: {
                mandatory: {
                    maxWidth: width,
                    maxHeight: height,
                    minWidth: width,
                    minHeight: height,
                    minFrameRate: 30,
                    maxFrameRate: 30,
                }
            },
            audioBitsPerSecond: 160000,
            videoBitsPerSecond: 10000000,
            frameSize: 0,
            mimeType: 'video/webm;codecs=h264'
        }

        this.page.on('console', async (msg: any) => {
            const args = await Promise.all(msg.args().map((itm: any) => itm.jsonValue()));
            let result = format(...args);
            result = result.replace(/clientLogger: /, '');
            consoleLog(result);
        });

        const consoleLog = (msg: string) => {
            logger.debug("Browser console: "+msg);
        };

        this.bbbStream = await getStream(this.page, bbbStreamOptions, consoleLog);

        this.waitForMeetingEnded();
        this.monitorForRedirect();

        return true;
    }

    async monitorForRedirect(){
        if(this.closing)
            return;
        
        try{
            const currentUrl = this.page.url();
            const joinUrlHost = new URL(this.joinUrl).hostname;
            const currentUrlHost = new URL(currentUrl).hostname;
            
            // Check if redirected away from the meeting
            if (currentUrlHost !== joinUrlHost || !currentUrl.includes('/html5client/')) {
                logger.error(`Browser was redirected away from meeting. Original: ${this.joinUrl}, Current: ${currentUrl}`);
                this.stopStream().then(() => {
                    this.streamEnded();
                });
                return;
            }
            
            // Check again in 5 seconds
            await new Promise(r => setTimeout(r, 5000));
            this.monitorForRedirect();
        }
        catch(error){
            if(!this.closing){
                logger.error("Error monitoring for redirect", error);
                await new Promise(r => setTimeout(r, 5000));
                this.monitorForRedirect();
            }
        }
    }

    async waitForMeetingEnded(){
        if(this.closing)
            return;
        try{
            await this.page.waitForSelector('[data-test="meetingEndedModal"]');
            logger.info("Meeting ended or user removed");
            this.stopStream().then(() => {
                this.streamEnded();
            });
        }
        catch(error){
            this.waitForMeetingEnded();
        }
    }


    pause(){
        this.updateProgress("paused");
        logger.debug("Pause image "+this.pauseImageUrl);
        this.page.evaluate((pauseImageUrl: string) => {
            // If no overlay exists, add new overlay
            if(!document.getElementById('block-overlay')){
                const g = document.createElement('div');
                g.setAttribute("id", "block-overlay");
                g.setAttribute("style",'position: fixed; top: 0; right: 0; left: 0; bottom: 0; background-image: url("'+pauseImageUrl+'"); background-size: cover; background-position: center; z-index: 100000; background-color: #000;');
                document.body.appendChild(g);   
            }
        }, this.pauseImageUrl);

        this.bbbStream.mute();
    }

    resume(){
        this.updateProgress("running");
        this.page.evaluate(() => {
            // Remove overlay if it exists
            if(document.getElementById('block-overlay')){
                document.getElementById('block-overlay').remove();
            }
        }); 

        this.bbbStream.unmute();
    }

    async startStream(){
        logger.info('Starting job '+ this.job.id);

        this.handleRedisMessages();

        return new Promise<string>(async (resolve) => {

            this.streamEnded = () => resolve("ended");

            try {
                // Start streaming
                await this.updateProgress("starting");

                logger.info('Starting streaming');

                const openMeeting = await this.openBBBMeeting();
                if(openMeeting === false){
                    throw new UnrecoverableError('Failed to join meeting');
                }
    
                this.rtmpStream = this.streamToRtmp();
                this.bbbStream.stream.pipe(this.rtmpStream.stdin);

                logger.info('Started streaming');
                await this.updateProgress("running");

            } catch (error) {
                logger.error(error);

                this.stopStream().then(() => {
                    if(error instanceof UnrecoverableError)
                        throw error;
                    else
                        throw new Error('Error during streaming: '+JSON.stringify(error));
                })
                
            }

        });
    }

    async stopStream(){
        if(this.closing)
            return;
        this.closing = true;

        logger.info('Stopping streaming');
        

        await this.redis.quit();

        await new Promise(r => setTimeout(r, 2000));
        
        try{
            await this.page.close();
            logger.info("Page closed");
        }
        catch(error){
            logger.error({ error }, 'Error closing page');
        }

        try{
            this.bbbStream.stream.destroy();
            logger.info("Stream stopped");
        }
        catch(error){
            logger.error({ error }, 'Error stopping stream');

        }

        try{
            await this.browser.close();
            logger.info("Browser closed");
        }
        catch(error){
            logger.error({ error }, 'Error closing browser');
            
            if (this.browser && this.browser.process() != null){
                this.browser.process().kill('SIGKILL');
            }
        }

        try{
            this.rtmpStream.kill('SIGKILL');
            logger.info("FFmpeg closed");
        }
        catch(error){
            logger.error({ error }, 'Error closing FFmpeg');
        }

        

        await new Promise(r => setTimeout(r, 2000));
   }

   streamToRtmp(){
    const ffmpeg = spawn('ffmpeg', [
        "-loglevel","info",

        "-thread_queue_size", "4096",

        '-i', '-',

        "-crf", ffmpegCRF, 
        '-bf', '2', 
   
        '-vcodec', 'libx264',
        '-x264-params', 'keyint=30:scenecut=-1',
        '-profile:v', 'high',
        '-pix_fmt', "yuv420p",

        "-b:v", ffmpegBitrate+"M",
        "-maxrate", ffmpegBitrate+"M",
        '-bufsize', ffmpegBitrate+"M",

        "-vf", "fps=fps=30",

        '-r', '30',
        '-g', '60',
        "-preset", "ultrafast",
        "-tune", "zerolatency",
 

        '-acodec', 'aac',
        "-b:a", "160k",
        "-ar", "48000",
        "-ac", "2",

        "-threads", "0",
        "-cpu-used","0",

        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        this.rtmpUrl
    ],
    {
        detached: true
    });

    ffmpeg.on('close', (code) => {
        logger.error({ code }, 'FFmpeg child process closed');
        handleFFmpegError(new Error("FFmpeg child process closed, code " + code));
    });

    const handleFFmpegError = (error: any) => {
        if(!this.closing){
            this.stopStream().then(() => {
                switch(this.ffmpegError){
                    case 'Input/output error':
                        throw new UnrecoverableError('Input/output error');
                    case 'Connection timed out':
                        throw new Error('Connection timed out');
                    default:
                        throw new Error(error);
                }
            })
        }
    }


    const regex = new RegExp('frame=\\s*(?<nframe>[0-9]+)\\s+fps=\\s*(?<nfps>[0-9\\.]+)\\s+q=(?<nq>[0-9\\.-]+)\\s+(L?)\\s*size=\\s*(?<nsize>[0-9]+)(?<ssize>kB|mB|b)?\\s*time=\\s*(?<sduration>[0-9\\:\\.]+)\\s*bitrate=\\s*(?<nbitrate>[0-9\\.]+)(?<sbitrate>bits\\\/s|mbits\\\/s|kbits\\\/s)?.*(dup=(?<ndup>\\d+)\\s*)?(drop=(?<ndrop>\\d+)\\s*)?speed=\\s*(?<nspeed>[0-9\\.]+)x', '')

    // @ts-ignore
    const average = list => list.reduce((prev, curr) => prev + curr) / list.length;

    let fpsArray: Array<number> = [];
    let bitrateArray: Array<number> = [];
    let speedArray: Array<number> = [];
    let interation = 0;

    ffmpeg.stdin.on('error', (error) => {
        logger.error({error}, 'FFmpeg STDIN error');
        handleFFmpegError(error);
    });


    ffmpeg.stderr.on('data', (data) => {
        const m = regex.exec(
            data.toString()
        );


        if(m !== null ){
            let { nfps, nbitrate, sbitrate, nspeed} =  m.groups;

            logger.debug({
                fps: nfps,
                bitrate: nbitrate+sbitrate,
                speed: nspeed
            }, 'FFmpeg metrics');

            let bitrate = parseFloat(nbitrate);
            let fps = parseFloat(nfps);
            let speed = parseFloat(nspeed);

            if(sbitrate == "bits/s")
                bitrate/=1000;

            if(sbitrate == "mbits/s")
                bitrate*=1000;

            bitrate = Math.round(bitrate);


            fpsArray.unshift(fps);
            fpsArray = fpsArray.slice(0,ffmpegMetricsAvgLength);

            bitrateArray.unshift(bitrate);
            bitrateArray = bitrateArray.slice(0,ffmpegMetricsAvgLength);

            speedArray.unshift(speed);
            speedArray = speedArray.slice(0,ffmpegMetricsAvgLength);

            interation++;

            if(interation == ffmpegMetricsInterval){
                interation = 0;

                const fpsAvg = Math.round(average(fpsArray));
                const bitrateAvg = Math.round(average(bitrateArray));
                const speedAvg = Math.round(average(speedArray)*100)/100;


                if(speedAvg < 0.9){
                    logger.warn('FFmpeg is overloaded, cannot keep up with encoding, speed: '+speedAvg);
                }

                logger.debug({
                    fps: fpsAvg,
                    bitrate: bitrateAvg,
                    speed: speedAvg
                }, 'FFmpeg AVG metrics');

                if(this.status == 'running' || this.status == 'paused')
                    this.updateProgress(this.status, fpsAvg, bitrateAvg);
            }
        }
        else{
            // Remove all line breaks
            const ffmpegMessage = data.toString().replace(/(\r\n|\n|\r)/gm, "");

            if(ffmpegMessage.includes('Input/output error')){
                this.ffmpegError = 'Input/output error';
                logger.error('FFmpeg input/output error: '+ffmpegMessage);
            } 
            else if(ffmpegMessage.includes('Connection timed out')){
                this.ffmpegError = 'Connection timed out';
                logger.error('FFmpeg connection timed out: '+ffmpegMessage);
            }
            else
                logger.debug('FFmpeg: '+ffmpegMessage);
        }
    });

    ffmpeg.stdout.on('data', (data) => {
        logger.info('FFmpeg STDOUT:'+ data.toString());
    })


   
     return ffmpeg;
}

}
