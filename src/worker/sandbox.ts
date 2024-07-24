import { SandboxedJob } from 'bullmq';
import { BBBLiveStream } from "./BBBLiveStream";

module.exports = async (job: SandboxedJob) => {
    const livestream = new BBBLiveStream(job);
    return await livestream.startStream();
};