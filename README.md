# BBB-Streaming-Server

The **BBB-Streaming-Server** enables multiple BigBlueButton (BBB) meetings to be streamed to an RTMP endpoint without requiring any modifications to BBB.

A separate UI _(not included)_ or an integration into LMS platforms or BBB frontends like Greenlight or PILOS is required to use this API.

---

This Software uses BigBlueButton and is not endorsed or certified by BigBlueButton Inc. BigBlueButton and the BigBlueButton Logo are trademarks of BigBlueButton Inc.

---

## Project Architecture
This project consists of two main components:

- **Controller** – Provides an API to create and manage streaming jobs.
- **Worker** – Processes streaming jobs by joining a BBB meeting as a bot. It uses Puppeteer to control the browser and FFmpeg to stream the meeting.

## Getting Started

### Requirements
- Linux server (e.g., Ubuntu)
- Docker Compose

#### Resource Requirements
It is recommended that each worker has sufficient resources to spawn a browser to join the BBB meeting, and to encode and send a livestream video to the RTMP endpoint.

Recommendations (per livestream)
- CPUs: 2x
- Memory: 2 GB
- Bandwidth: at least 10Mbit/s upstream

The CPU, memory and bandwidth requirements also depend on the resource consumption of the BBB meeting and are therefore basically independent of streaming. With these requirements, it is possible, for example, to play movies in Full HD (approx. 30 FPS) smoothly via the video player in BBB.

### Installation

1. Create a new directory and place the `docker-compose.yml` file in it.
2. Adjust the `replicas` value to set the number of workers. By default, each worker can handle one streams.
3. Modify the `CONCURRENCY` environment variable if you want to allow multiple meetings per worker.
4. Start the stack by running:
   ```sh
   docker compose up -d
   ```

### Security Considerations

- By default, the API listens on `127.0.0.1:3000`. This can be modified in `docker-compose.yml`.
- The system sending API requests (e.g., a BBB frontend) must be able to reach the API.
- The API must be able to reach the server specified as the callback in each job creation request.
- It is recommended to avoid directly exposing the API. Instead, use a reverse proxy to:
  - Secure the connection with SSL/TLS.
  - Implement authentication (e.g., Basic Auth).

## Environment Variables

### Controller Container
| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_HOST` | string | `redis` | Redis host address. |
| `REDIS_PORT` | int | `6379` | Redis port number. |
| `FAILED_JOB_ATTEMPTS` | int | `3` | Number of automatic retries if a streaming job fails. |
| `KEEP_COMPLETED_JOBS_DURATION` | int | `3600` | Time (in seconds) to retain completed jobs before removal. After this, API calls to the job ID may return `404`. |
| `KEEP_FAILED_JOBS_DURATION` | int | `3600` | Time (in seconds) to retain failed jobs before removal. After this, API calls to the job ID may return `404`. |

### Worker Container
| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REDIS_HOST` | string | `redis` | Redis host address. |
| `REDIS_PORT` | int | `6379` | Redis port number. |
| `CONCURRENCY` | int | `1` | Maximum number of parallel streaming jobs. |
| `FFMPEG_BITRATE` | int | `10` | Target bitrate (Mbps) for the output video stream. |
| `FFMPEG_CRF` | int | `23` | Video quality setting (lower is better; `18` is visually lossless, see FFmpeg docs). |
| `FFMPEG_METRICS_INTVL` | int | `5` | Interval (in seconds) for publishing FFmpeg metrics. |
| `FFMPEG_METRICS_AVG_LEN` | int | `10` | Length of the moving average filter for FFmpeg metrics. |
| `JSON_LOGS` | boolean | `true` | Enable logging in JSON format. |


## API Documentation

The Controller exposes the following API endpoints:

- `GET /health` – Check server health and basic metrics.
- `GET /metrics` – Prometheus formatted metrics.
- `POST /` – Create a new streaming job.
- `GET /{jobId}` – Retrieve the status of a streaming job by job ID.
- `POST /{jobId}/stop` – Stop a running stream.
- `POST /{jobId}/pause` – Pause a running stream.
- `POST /{jobId}/resume` – Resume a paused stream.

For more details, refer to the [API Documentation](https://thm-health.github.io/BBB-Streaming-Server/).
