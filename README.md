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

## API Documentation

The Controller exposes the following API endpoints:

- `GET /health` – Check server health and basic metrics.
- `POST /` – Create a new streaming job.
- `GET /{jobId}` – Retrieve the status of a streaming job by job ID.
- `POST /{jobId}/stop` – Stop a running stream.
- `POST /{jobId}/pause` – Pause a running stream.
- `POST /{jobId}/resume` – Resume a paused stream.

For more details, refer to the [API Documentation](https://thm-health.github.io/BBB-Streaming-Server/).

