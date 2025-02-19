import { launch, getStream, getStreamOptions } from "./PuppeteerStream";
import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import Redis from "ioredis";
import { SandboxedJob } from 'bullmq';
import { Browser, Page } from "puppeteer-core";

const redisHost = process.env.REDIS_HOST || 'redis';
const redisPort = Number(process.env.REDIS_PORT) || 6379;
const ffmpegMetricsInterval = Number(process.env.FFMPEG_METRICS_INTVL) || 5;
const ffmpegMetricsAvgLength = Number(process.env.FFMPEG_METRICS_AVG_LEN) || 10;
const debug = Boolean(process.env.DEBUG) || false;
const width = 1920;
const height = 1080;
const constantMotionElementHeight = 2;

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

    constructor(job: any){
        this.job = job;
        this.joinUrl = job.data.joinUrl;
        this.pauseImageUrl = job.data.pauseImageUrl;
        this.rtmpUrl = job.data.rtmpUrl;
    
        this.redis = new Redis({
            port: redisPort,
            host: redisHost,
            maxRetriesPerRequest: null
        });
    }


    async updateProgress(status: string, fps: number = null, bitrate: number = null){
        this.status = status;
        return await this.job.updateProgress({ status, fps, bitrate });
    }

    log(message: string, type: string = "info"){
        const dateTime = new Date().toLocaleString();
        const logMessage = dateTime+": ["+this.job.id+"] "+message; 
        switch(type){
            case "debug":
                if(debug)
                    console.debug(logMessage);
                break;
            case "error":
                console.error(logMessage);
                break;
            case "warn":
                console.warn(logMessage);
                break;
            default:
                console.log(logMessage);
                break;
        }
    }

    handleRedisMessages() {
        this.redis.subscribe("job-"+this.job.id, (err) => {
            if (err) {
                this.stopStream();
                throw new Error("Failed to subscribe to redis control ws: "+err.message);
            } else {
                this.log(
                    `Connected to redis control ws.`
                );
            }
        });

        this.redis.on("message", async(channel, message) => {
            this.log(`Received ${message} from ${channel}`);
            const data = JSON.parse(message);

            if (data.action === "pause") {
                this.pause();
            }

            if (data.action === "resume") {
                this.resume();
            }

            if (data.action === "stop") {
                this.stopStream().then(() => {
                    this.log("Stream ended successfully");
                    this.streamEnded();
                })
            }
        });
    }

    async openBBBMeeting(){
        const options = {
            executablePath: "/usr/bin/google-chrome",
            defaultViewport: { width, height:height+constantMotionElementHeight },
            //dumpio: true,
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
            await this.page.locator('[data-test="listenOnlyBtn"]').setTimeout(30000).click();
        }
        catch(error){
            this.log("Could not found audio button");
            this.stopStream();
            return false;
        }

        const bbbStreamOptions: getStreamOptions = {
            audio: true,
            video: true,
            audioBitsPerSecond: 160000,
            videoBitsPerSecond: 2500000,
            frameSize: 1000,
            mimeType: 'video/webm;codecs=h264'
        }

        this.page.on('console', (message: any) => {
            consoleLog(message.text());
        });

        const consoleLog = (msg: string) => {
            this.log("CONSOLE: "+msg, 'debug');
        };

        // Add constant motion element to create constant motion in the browser
        this.page.evaluate((constantMotionElementHeight: number) => {
            var styles = `

            .constant-motion {
                background-image: repeating-linear-gradient(90deg, #000, #000 50%, #FFF 50%, #FFF);
                background-position-x: left;
                background-position-y: center;
                background-size: 1% 100%;
                animation: l1 10s infinite linear;
            }
            @keyframes l1 {
                100% {background-position: right}
            }
            `

            var styleSheet = document.createElement("style");
            styleSheet.textContent = styles;
            document.head.appendChild(styleSheet);

            const constantMotionWrapper = document.createElement('div');
            constantMotionWrapper.setAttribute("style",'position: fixed; top: 0; left: 0; right: 0; z-index: 100005; background: #FFF;');

            const constantMotionElement = document.createElement('div');
            constantMotionElement.setAttribute("style",'height: '+constantMotionElementHeight+'px; width: 100%;');
            constantMotionElement.setAttribute("class", "constant-motion");
            
            constantMotionWrapper.appendChild(constantMotionElement);
            document.body.appendChild(constantMotionWrapper);
        }, constantMotionElementHeight);

        this.bbbStream = await getStream(this.page, bbbStreamOptions, consoleLog);

        this.waitForMeetingEnded();
    }

    async waitForMeetingEnded(){
        if(this.closing)
            return;
        try{
            await this.page.waitForSelector('[data-test="meetingEndedModal"]');
            this.log("Meeting ended or user removed");
            this.stopStream();
        }
        catch(error){
            this.waitForMeetingEnded();
        }
    }

    pause(){
        this.updateProgress("paused");
        this.log("Pause image "+this.pauseImageUrl);
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
        this.log('Processing job '+ this.job.id);

        this.handleRedisMessages();

        return new Promise<string>(async (resolve) => {

            this.streamEnded = () => resolve("ended");

            try {
                // Start streaming
                await this.updateProgress("starting");
                this.log('Starting streaming');

                const openMeeting = await this.openBBBMeeting();
                if(openMeeting === false){
                    this.streamEnded();
                    return;
                }

                await this.updateProgress("running");
                this.log('Started streaming');
    
                this.rtmpStream = this.streamToRtmp();

                await this.updateProgress("running");

                this.bbbStream.stream.pipe(this.rtmpStream.stdin);


            } catch (error) {
                this.log('Error during streaming: '+JSON.stringify(error),'error');
                // @ts-ignore
                this.log('Error during streaming: '+JSON.stringify(error?.message),'error');
                // @ts-ignore
                this.log('Error during streaming: '+JSON.stringify(error?.stack),'error');

                this.stopStream().then(() => {
                    throw new Error('Error during streaming: '+JSON.stringify(error));
                })
                
            }

        });
    }

    async stopStream(){
        if(this.closing)
            return;
        this.closing = true;

        this.log('Stopping streaming');
        

        await this.redis.quit();

        await new Promise(r => setTimeout(r, 2000));
        
        try{
            await this.page.close();
            this.log("Page closed");
        }
        catch(error){
            this.log('Error closing page:'+JSON.stringify(error),'error');
        }

        try{
            this.bbbStream.stream.destroy();
            this.log("Stream stopped");
        }
        catch(error){
            this.log('Error stopping stream: '+JSON.stringify(error),'error');
        }

        try{
            await this.browser.close();
            this.log("Browser closed");
        }
        catch(error){
            this.log("Error closing browser:" +JSON.stringify(error),'error');
            
            if (this.browser && this.browser.process() != null){
                this.browser.process().kill('SIGKILL');
            }
        }

        try{
            this.rtmpStream.kill('SIGKILL');
            this.log("FFmpeg stopped");
        }
        catch(error){
            this.log('Error killing FFmpeg:'+JSON.stringify(error),'error');
        }

        

        await new Promise(r => setTimeout(r, 2000));
   }

   streamToRtmp(){
    const ffmpeg = spawn('ffmpeg', [
        //"-y", "-nostats",
        "-loglevel","info",

        "-thread_queue_size", "4096",

        '-re',
        '-i', '-',


        //'-vcodec', 'copy',

    
        "-crf", "23", 
        '-bf', '2', 
   
        '-vcodec', 'libx264',
        '-x264-params', 'keyint=30:scenecut=-1',
        //'-x264-params', 'nal-hrd=cbr',
        '-profile:v', 'high',
        '-pix_fmt', "yuv420p",

        "-b:v", "10M",
        "-maxrate", "10M",
        '-bufsize', '10M',

        //"-vf", "crop=1920:1070:0:10",
        //"-vf", "fps=fps=30",
        "-vf", "fps=fps=30, crop=1920:1080:0:"+constantMotionElementHeight,
       // "-fps_mode","cfr",

        //'-g', '60',

        '-r', '30',
        '-g', '15',
        "-preset", "ultrafast",
        //"-preset", "slow",
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

    ffmpeg.on('close', (code, signal) => {
        this.log('ERROR FFmpeg child process closed, code ' + code + ', signal ' + signal);
            
        if(!this.closing){
            this.stopStream().then(() => {
                throw new Error('FFmpeg closed, code ' + code + ', signal ' + signal);
            })
        }
    });


    const regex = new RegExp('frame=\\s*(?<nframe>[0-9]+)\\s+fps=\\s*(?<nfps>[0-9\\.]+)\\s+q=(?<nq>[0-9\\.-]+)\\s+(L?)\\s*size=\\s*(?<nsize>[0-9]+)(?<ssize>kB|mB|b)?\\s*time=\\s*(?<sduration>[0-9\\:\\.]+)\\s*bitrate=\\s*(?<nbitrate>[0-9\\.]+)(?<sbitrate>bits\\\/s|mbits\\\/s|kbits\\\/s)?.*(dup=(?<ndup>\\d+)\\s*)?(drop=(?<ndrop>\\d+)\\s*)?speed=\\s*(?<nspeed>[0-9\\.]+)x', '')

    // @ts-ignore
    const average = list => list.reduce((prev, curr) => prev + curr) / list.length;

    let fpsArray: Array<number> = [];
    let bitrateArray: Array<number> = [];
    let interation = 0;

    ffmpeg.stderr.on('data', (data) => {
        const m = regex.exec(
            data.toString()
        );

        if(m !== null ){
            let { nfps, nbitrate, sbitrate, sduration } =  m.groups;

            this.log('['+sduration+'] FPS: '+nfps+' Bitrate: '+nbitrate+sbitrate, 'debug');

            let bitrate = parseFloat(nbitrate);
            let fps = parseFloat(nfps);

            if(sbitrate == "bits/s")
                bitrate/=1000;

            if(sbitrate == "mbits/s")
                bitrate*=1000;

            bitrate = Math.round(bitrate);


            fpsArray.unshift(fps);
            fpsArray = fpsArray.slice(0,ffmpegMetricsAvgLength);

            bitrateArray.unshift(bitrate);
            bitrateArray = bitrateArray.slice(0,ffmpegMetricsAvgLength);

            interation++;

            if(interation == ffmpegMetricsInterval){
                interation = 0;

                const fpsAvg = Math.round(average(fpsArray));
                const bitrateAvg = Math.round(average(bitrateArray));

                this.log('AVG: FPS: '+fpsAvg+' Bitrate: '+bitrateAvg+sbitrate, 'debug');

                if(this.status == 'running')
                    this.updateProgress(this.status, fpsAvg, bitrateAvg);
            }
        }
        else{
            this.log('FFmpeg:'+ data.toString(), 'debug');
        }
    });

    ffmpeg.stdout.on('data', (data) => {
        this.log('FFmpeg STDOUT:'+ data.toString());
    })


   
     return ffmpeg;
}

}