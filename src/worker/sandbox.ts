import { SandboxedJob } from 'bullmq';
import { BBBLiveStream } from "./BBBLiveStream";

module.exports = async (job: SandboxedJob) => {
    console.log("start job"+job.id);
    const livestream = new BBBLiveStream(job);
    return await livestream.startStream();
};